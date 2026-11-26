import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Painel de saúde (E20, migration 0085): o worker grava, só admin lê. */

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

describe.skipIf(!available)("painel de saúde", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let worker: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  let admin = "";
  let comum = "";

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    worker = createPool(urls.worker, 2);
    const pessoa = async (nome: string) =>
      (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@filtrovali.com.br`, nome])).rows[0]!.id;
    admin = await pessoa("admin");
    comum = await pessoa("comum");
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'admin')", [admin]);
  });
  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
  });

  it("o worker grava o estado; só quem administra lê; a tela não grava", async () => {
    await worker.query(
      `INSERT INTO estado_operacao (chave, valor) VALUES ('worker', $1) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, atualizado_em = now()`,
      [JSON.stringify({ versao: tag })],
    );
    const ler = (quem: string) => withPerson(app, quem, (db) => db.execute<{ v: string }>(sql`SELECT valor->>'versao' AS v FROM estado_operacao WHERE chave = 'worker'`));
    expect((await ler(admin)).rows).toEqual([{ v: tag }]);
    expect((await ler(comum)).rows).toEqual([]);
    await expect(app.query("INSERT INTO estado_operacao (chave, valor) VALUES ('backup', '{}')")).rejects.toThrow(/permission denied/);
    await expect(worker.query("INSERT INTO estado_operacao (chave, valor) VALUES ('outro', '{}')")).rejects.toThrow(/check constraint/);
  });

  it("o resumo do banco é só para quem administra", async () => {
    const b = (await withPerson(app, admin, (db) => db.execute<{ b: { tamanho_bytes: number; conexoes: number; maiores_tabelas: unknown[] } }>(sql`SELECT app.saude_banco() AS b`))).rows[0]!.b;
    expect(b.tamanho_bytes).toBeGreaterThan(0);
    expect(b.conexoes).toBeGreaterThan(0);
    expect(b.maiores_tabelas.length).toBeGreaterThan(0);
    const recusa = await withPerson(app, comum, (db) => db.execute(sql`SELECT app.saude_banco()`)).catch((e: { cause?: Error }) => e.cause?.message);
    expect(recusa).toMatch(/Só quem administra/);
  });
});
