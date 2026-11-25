import { randomUUID } from "node:crypto";

import { createPool, migrate, withPerson } from "@omni/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lerNovidadesDasMissoes } from "./novidades.ts";

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  app: process.env.TEST_DATABASE_URL_APP ?? "postgres://omni_app:omni_app_dev@localhost:5433/omni_test",
};
async function disponivel() {
  const c = new pg.Client({ connectionString: urls.owner, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    if (process.env.CI) throw new Error("Banco de teste indisponível no CI");
    return false;
  }
}
const available = await disponivel();

describe.skipIf(!available)("caixa única: missões com novidade", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const tag = randomUUID().slice(0, 6);
  let eu = "";
  let colega = "";
  const missoes: string[] = [];

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    const pessoa = async (n: string) => {
      const id = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${n}-${tag}@omni.invalid`, n])).rows[0]!.id;
      await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'operacao')", [id]);
      return id;
    };
    eu = await pessoa("eu");
    colega = await pessoa("colega");
    // Dois números de missão livres (não apaga missão de outro teste).
    const livres = (
      await owner.query<{ c: string }>("SELECT lpad(c::text, 4, '0') AS c FROM generate_series(1000, 1999) c WHERE NOT EXISTS (SELECT 1 FROM missions WHERE code = lpad(c::text, 4, '0')) ORDER BY random() LIMIT 2")
    ).rows.map((x) => x.c);
    for (const code of livres) {
      const id = (
        await owner.query<{ id: string }>(
          "INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ($1, $2, 'Cliente', true, now()) RETURNING id",
          [code, `nov-${tag}-${code}`],
        )
      ).rows[0]!.id;
      await owner.query("INSERT INTO mission_members (mission_id, channel, person_id, added_by) VALUES ($1, 'interno', $2, $2), ($1, 'interno', $3, $3)", [id, eu, colega]);
      missoes.push(id);
    }
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM missions WHERE id = ANY($1)", [missoes]);
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("aviso da IA conta como não lido, mas a hora da missão é a da última mensagem de pessoa", async () => {
    const [m1, m2] = missoes as [string, string];
    const msg = (m: string, autor: string | null, kind: string, body: string, ha: string) =>
      owner.query(`INSERT INTO mission_messages (mission_id, channel, author_person_id, kind, body, created_at) VALUES ($1, 'interno', $2, $3, $4, now() - $5::interval)`, [m, autor, kind, body, ha]);
    await msg(m1, colega, "texto", "Equipe chegou", "3 hours");
    await msg(m1, null, "ia", "Pergunta da IA", "1 minute"); // recente, mas não sobe a missão
    await msg(m2, null, "ia", "Só a IA", "2 minutes");
    await msg(m2, eu, "texto", "Minha mensagem", "5 hours"); // a minha não conta como não lida
    const r = await withPerson(app, eu, (db) => lerNovidadesDasMissoes(db));
    const de = (id: string) => r.find((x) => x.missionId === id);
    expect(de(m1)).toMatchObject({ dePessoas: 1, daIa: 1, previa: "Equipe chegou" });
    expect(Date.now() - new Date(de(m1)!.ultimaDePessoaEm!).getTime()).toBeGreaterThan(2 * 3600_000);
    expect(de(m2)).toMatchObject({ dePessoas: 0, daIa: 1, previa: "Minha mensagem" });
    // Quem não participa não vê nada destas missões.
    const fora = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, 'Fora') RETURNING id", [`fora-${tag}@omni.invalid`])).rows[0]!.id;
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'operacao')", [fora]);
    const deFora = await withPerson(app, fora, (db) => lerNovidadesDasMissoes(db));
    expect(deFora.filter((x) => missoes.includes(x.missionId))).toEqual([]);
  });
});
