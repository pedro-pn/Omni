import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Registro de incidentes (E21, migration 0086): só admin; encerrar exige causa; histórico; sem exclusão. */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  app: process.env.TEST_DATABASE_URL_APP ?? "postgres://omni_app:omni_app_dev@localhost:5433/omni_test",
};

async function disponivel(): Promise<boolean> {
  const client = new pg.Client({ connectionString: urls.owner, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    if (process.env.CI) throw new Error("Banco de teste indisponível no CI");
    return false;
  }
}
const available = await disponivel();

const erroDe = async (p: Promise<unknown>) => {
  try {
    await p;
    return "";
  } catch (e) {
    const c = (e as { cause?: { message?: string } }).cause;
    return c?.message ?? (e as Error).message;
  }
};

describe.skipIf(!available)("registro de incidentes", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  let admin = "";
  let comum = "";

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    const pessoa = async (nome: string) =>
      (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@filtrovali.com.br`, nome])).rows[0]!.id;
    admin = await pessoa("admin");
    comum = await pessoa("comum");
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'admin')", [admin]);
  });
  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
  });

  const criar = (quem: string) =>
    withPerson(app, quem, (db) =>
      db.execute<{ id: string }>(sql`
        INSERT INTO incidentes (titulo, tipo, gravidade, inicio, conhecido_em, o_que_aconteceu, criado_por)
        VALUES (${"teste " + tag}, 'dados', 'media', now() - interval '1 hour', now(), 'linhas foram para fora', ${quem}::uuid)
        RETURNING id`),
    );

  it("só quem administra cria e lê", async () => {
    expect(await erroDe(criar(comum))).toMatch(/row-level security/);
    const id = (await criar(admin)).rows[0]!.id;
    const ler = (quem: string) => withPerson(app, quem, (db) => db.execute(sql`SELECT id FROM incidentes WHERE id = ${id}::uuid`)).then((r) => r.rows.length);
    expect(await ler(admin)).toBe(1);
    expect(await ler(comum)).toBe(0);
  });

  it("não cria em nome de outra pessoa", async () => {
    const msg = await erroDe(
      withPerson(app, admin, (db) =>
        db.execute(sql`INSERT INTO incidentes (titulo, tipo, gravidade, inicio, conhecido_em, o_que_aconteceu, criado_por)
                       VALUES ('outro', 'erro', 'baixa', now(), now(), 'x x x', ${comum}::uuid)`),
      ),
    );
    expect(msg).toMatch(/row-level security/);
  });

  it("encerrar exige solução, causa e correção; com dado pessoal, titulares e comunicações", async () => {
    const id = (await criar(admin)).rows[0]!.id;
    const mudar = (campos: ReturnType<typeof sql>) =>
      erroDe(withPerson(app, admin, (db) => db.execute(sql`UPDATE incidentes SET ${campos}, atualizado_por = ${admin}::uuid WHERE id = ${id}::uuid`)));
    expect(await mudar(sql`status = 'resolvido'`)).toMatch(/incidentes_resolvido/);
    expect(await mudar(sql`status = 'encerrado', resolvido_em = now()`)).toMatch(/incidentes_causa/);
    expect(await mudar(sql`status = 'encerrado', resolvido_em = now(), causa = 'drop no lugar errado', correcao = 'descarte na descoberta', dados_pessoais = true`)).toMatch(
      /incidentes_titulares/,
    );
    expect(
      await mudar(
        sql`status = 'encerrado', resolvido_em = now(), causa = 'drop no lugar errado', correcao = 'descarte na descoberta', dados_pessoais = true, titulares = 'telefones mascarados', comunicacoes = 'não necessária'`,
      ),
    ).toBe("");
    expect(await mudar(sql`resolvido_em = inicio - interval '1 minute'`)).toMatch(/incidentes_datas/);
  });

  it("a alteração vai para o histórico só com os nomes dos campos", async () => {
    const id = (await criar(admin)).rows[0]!.id;
    await withPerson(app, admin, (db) =>
      db.execute(sql`UPDATE incidentes SET impacto = 'segredo do texto', atualizado_por = ${admin}::uuid, atualizado_em = now() WHERE id = ${id}::uuid`),
    );
    const { rows } = await owner.query<{ action: string; actor_person_id: string; metadata: { campos?: string[] } }>(
      "SELECT action, actor_person_id, metadata FROM audit_log WHERE entity_type = 'incidente' AND entity_id = $1 ORDER BY id",
      [id],
    );
    expect(rows.map((r) => r.action)).toEqual(["incidente.criado", "incidente.alterado"]);
    expect(rows[1]!.actor_person_id).toBe(admin);
    expect(rows[1]!.metadata.campos).toEqual(["impacto"]);
    expect(JSON.stringify(rows)).not.toContain("segredo do texto");
  });

  it("ninguém da aplicação apaga nem troca quem criou", async () => {
    const id = (await criar(admin)).rows[0]!.id;
    expect(await erroDe(withPerson(app, admin, (db) => db.execute(sql`DELETE FROM incidentes WHERE id = ${id}::uuid`)))).toMatch(/permission denied/);
    expect(await erroDe(withPerson(app, admin, (db) => db.execute(sql`UPDATE incidentes SET criado_por = ${comum}::uuid WHERE id = ${id}::uuid`)))).toMatch(
      /permission denied/,
    );
    expect(
      await erroDe(withPerson(app, admin, (db) => db.execute(sql`UPDATE incidentes SET titulo = 'x x x', atualizado_por = ${comum}::uuid WHERE id = ${id}::uuid`))),
    ).toMatch(/row-level security/);
  });
});
