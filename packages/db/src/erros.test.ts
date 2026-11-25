import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Erros do sistema (migration 0079): web e worker gravam pela função; só admin lê e marca como visto. */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  app: process.env.TEST_DATABASE_URL_APP ?? "postgres://omni_app:omni_app_dev@localhost:5433/omni_test",
  worker: process.env.TEST_DATABASE_URL_WORKER ?? "postgres://omni_worker:omni_worker_dev@localhost:5433/omni_test",
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

describe.skipIf(!available)("erros do sistema", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let worker: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  const assinatura = `teste|${tag}`;
  const p: Record<string, string> = {};
  async function pessoa(nome: string, perfil: string | null) {
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@filtrovali.com.br`, nome]);
    if (perfil) await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, perfil]);
    return rows[0]!.id;
  }
  const registrar = (pool: pg.Pool, mensagem: string) =>
    pool.query("SELECT app.registrar_erro($1, 'web', 'TypeError', $2, NULL, '/api/teste', 'abc123')", [assinatura, mensagem]);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    worker = createPool(urls.worker, 2);
    p.admin = await pessoa("admin", "admin");
    p.diretoria = await pessoa("diretoria", "diretoria");
    p.operacao = await pessoa("operacao", "operacao");
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM system_errors WHERE fingerprint = $1", [assinatura]);
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
  });

  it("web e worker gravam pela função, que soma ocorrências; só admin lê", async () => {
    await registrar(app, "primeira");
    await registrar(worker, "segunda");
    const { rows } = await owner.query("SELECT id, occurrences, message FROM system_errors WHERE fingerprint = $1", [assinatura]);
    expect(rows[0]).toMatchObject({ occurrences: 2, message: "segunda" });
    const id = rows[0].id as string;

    const ver = (quem: string) => withPerson(app, quem, (db) => db.execute(sql`SELECT id FROM system_errors WHERE id = ${id}::uuid`)).then((r) => r.rows.length);
    expect(await ver(p.admin!)).toBe(1);
    expect(await ver(p.diretoria!)).toBe(0);
    expect(await ver(p.operacao!)).toBe(0);
    // O web não escreve direto na tabela.
    await expect(app.query("INSERT INTO system_errors (fingerprint, source, name, message, location) VALUES ('x', 'web', 'x', 'x', 'x')")).rejects.toThrow();
  });

  it("admin marca como visto em nome próprio; erro que volta reabre", async () => {
    const id = (await owner.query("SELECT id FROM system_errors WHERE fingerprint = $1", [assinatura])).rows[0].id as string;
    await expect(withPerson(app, p.admin!, (db) => db.execute(sql`UPDATE system_errors SET reviewed_at = now(), reviewed_by = ${p.diretoria}::uuid WHERE id = ${id}::uuid`))).rejects.toThrow();
    const r = await withPerson(app, p.operacao!, (db) => db.execute(sql`UPDATE system_errors SET reviewed_at = now(), reviewed_by = ${p.operacao}::uuid WHERE id = ${id}::uuid`));
    expect(r.rowCount).toBe(0);
    await withPerson(app, p.admin!, (db) => db.execute(sql`UPDATE system_errors SET reviewed_at = now(), reviewed_by = ${p.admin}::uuid WHERE id = ${id}::uuid`));
    expect((await owner.query("SELECT reviewed_by FROM system_errors WHERE id = $1", [id])).rows[0].reviewed_by).toBe(p.admin);
    await registrar(worker, "voltou");
    expect((await owner.query("SELECT reviewed_at FROM system_errors WHERE id = $1", [id])).rows[0].reviewed_at).toBeNull();
  });

  it("o worker marca o aviso e apaga, mas não muda o texto", async () => {
    const id = (await owner.query("SELECT id FROM system_errors WHERE fingerprint = $1", [assinatura])).rows[0].id as string;
    await worker.query("UPDATE system_errors SET alerted_at = now() WHERE id = $1", [id]);
    await expect(worker.query("UPDATE system_errors SET message = 'x' WHERE id = $1", [id])).rejects.toThrow();
  });
});
