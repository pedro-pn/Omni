import { randomBytes, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Meus dados (LGPD art. 18, II; migration 0082): só os da própria pessoa, sem segredos, com auditoria. */

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

describe.skipIf(!available)("meus dados", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  let eu = "";
  let outra = "";
  const segredo = randomBytes(32);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    const pessoa = async (nome: string) =>
      (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@filtrovali.com.br`, `${nome} ${tag}`])).rows[0]!.id;
    eu = await pessoa("eu");
    outra = await pessoa("outra");
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'operacao')", [eu]);
    await owner.query("INSERT INTO sessions (token_hash, person_id, expires_at, ip) VALUES ($1, $2, now() + interval '1 day', '10.1.2.3')", [segredo, eu]);
    await owner.query("INSERT INTO api_keys (person_id, name, key_prefix, key_hash, scopes) VALUES ($1, 'Minha chave', 'foco_live_abc', $2, ARRAY['read'])", [eu, randomBytes(32)]);
    await owner.query("INSERT INTO tasks (content, created_by, owner_person_id) VALUES ($1, $2, $2), ($3, $4, $4)", [`minha ${tag}`, eu, `dela ${tag}`, outra]);
    await owner.query("INSERT INTO notifications (person_id, kind, title) VALUES ($1, 'teste_push', $2), ($3, 'teste_push', $4)", [eu, `aviso meu ${tag}`, outra, `aviso dela ${tag}`]);
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM notifications WHERE person_id = ANY($1::uuid[])", [[eu, outra]]);
    await owner?.query("DELETE FROM tasks WHERE content LIKE $1", [`% ${tag}`]);
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("traz os dados da própria pessoa e nada de outra; sem hash de sessão nem de chave", async () => {
    const d = (await withPerson(app, eu, (db) => db.execute<{ d: Record<string, unknown> }>(sql`SELECT app.meus_dados() AS d`))).rows[0]!.d;
    expect(d.pessoa).toMatchObject({ email: `eu-${tag}@filtrovali.com.br` });
    expect(d.perfis).toEqual([expect.objectContaining({ perfil: "operacao" })]);
    expect((d.tarefas as { content: string }[]).map((t) => t.content)).toEqual([`minha ${tag}`]);
    expect((d.avisos as { titulo: string }[]).map((a) => a.titulo)).toEqual([`aviso meu ${tag}`]);
    expect(d.sessoes).toEqual([expect.objectContaining({ ip: "10.1.2.3" })]);
    expect(d.chaves_de_api).toEqual([expect.objectContaining({ name: "Minha chave", key_prefix: "foco_live_abc" })]);

    const texto = JSON.stringify(d);
    expect(texto).not.toContain(`dela ${tag}`);
    expect(texto).not.toMatch(/token_hash|key_hash|chave_cifrada|token_ciphertext|p256dh/);
    expect(texto).not.toContain(segredo.toString("hex"));
  });

  it("o pedido fica na auditoria; sem sessão, recusa", async () => {
    const n = async () => (await owner.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_person_id = $1 AND action = 'dados.exportados'", [eu])).rows[0].n;
    const antes = await n();
    await withPerson(app, eu, (db) => db.execute(sql`SELECT app.meus_dados()`));
    expect(await n()).toBe(antes + 1);
    await expect(app.query("SELECT app.meus_dados()")).rejects.toThrow(/Entre no Omni/);
  });
});
