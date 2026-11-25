import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Alertas de risco (migration 0065): só admin e diretoria leem; o worker lê só os downloads registrados. */

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

describe.skipIf(!available)("alertas de risco", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let worker: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  const p: Record<string, string> = {};
  async function pessoa(nome: string, perfil: string | null) {
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@filtrovali.com.br`, nome]);
    if (perfil) await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, perfil]);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    worker = createPool(urls.worker, 2);
    p.admin = await pessoa("admin", "admin");
    p.diretoria = await pessoa("diretoria", "diretoria");
    p.gerente = await pessoa("gerente", "gerente");
    p.operacao = await pessoa("operacao", "operacao");
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM risk_alerts WHERE person_id = ANY($1::uuid[])", [Object.values(p)]);
    // audit_log é só de inserção (gatilho): os registros de teste ficam, de pessoas deste teste.
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
  });

  it("o worker grava; admin e diretoria leem e marcam como visto; os demais não veem", async () => {
    const { rows } = await worker.query<{ id: string }>(
      "INSERT INTO risk_alerts (kind, person_id, window_start, reason) VALUES ('downloads_em_massa', $1, date_trunc('hour', now()), 'teste') RETURNING id",
      [p.operacao],
    );
    const id = rows[0]!.id;
    await expect(
      worker.query("INSERT INTO risk_alerts (kind, person_id, window_start, reason) VALUES ('downloads_em_massa', $1, date_trunc('hour', now()), 'repetido')", [p.operacao]),
    ).rejects.toThrow(/duplicate/); // um por pessoa, tipo e hora
    const ver = (quem: string) => withPerson(app, quem, (db) => db.execute(sql`SELECT id FROM risk_alerts WHERE id = ${id}::uuid`)).then((r) => r.rows.length);
    expect(await ver(p.admin!)).toBe(1);
    expect(await ver(p.diretoria!)).toBe(1);
    expect(await ver(p.gerente!)).toBe(0);
    expect(await ver(p.operacao!)).toBe(0);
    await withPerson(app, p.diretoria!, (db) => db.execute(sql`UPDATE risk_alerts SET reviewed_at = now(), reviewed_by = ${p.diretoria}::uuid WHERE id = ${id}::uuid`));
    expect((await owner.query("SELECT reviewed_by FROM risk_alerts WHERE id = $1", [id])).rows[0].reviewed_by).toBe(p.diretoria);
    // Ninguém marca em nome de outra pessoa; quem não vê não altera.
    await expect(withPerson(app, p.admin!, (db) => db.execute(sql`UPDATE risk_alerts SET reviewed_by = ${p.diretoria}::uuid WHERE id = ${id}::uuid`))).rejects.toThrow();
    const r = await withPerson(app, p.gerente!, (db) => db.execute(sql`UPDATE risk_alerts SET reviewed_at = now(), reviewed_by = ${p.gerente}::uuid WHERE id = ${id}::uuid`));
    expect(r.rowCount).toBe(0);
  });

  it("cada pessoa registra os próprios downloads; o worker lê só os downloads da auditoria", async () => {
    await withPerson(app, p.operacao!, (db) =>
      db.execute(sql`INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id) VALUES (${p.operacao}::uuid, 'arquivo.baixado', 'sharepoint', 'x1')`),
    );
    await owner.query("INSERT INTO audit_log (actor_person_id, action) VALUES ($1, 'perfil.concedido')", [p.admin]);
    const lidos = await worker.query("SELECT action FROM audit_log WHERE actor_person_id = ANY($1::uuid[])", [Object.values(p)]);
    expect(lidos.rows.map((x) => x.action)).toEqual(["arquivo.baixado"]);
  });
});
