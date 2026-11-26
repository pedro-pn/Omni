import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Desempenho (E19, migration 0084): o web soma por hora e rota; só admin lê. */

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

describe.skipIf(!available)("desempenho", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  const rota = `GET /teste-${tag}`;
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
    await owner?.query("DELETE FROM desempenho_rotas WHERE rota = $1", [rota]);
    await Promise.all([owner?.end(), app?.end()]);
  });

  const lote = (n: number, soma: number, max: number, faixas: number[], erros = 0, hora = "2026-11-26T10:20:00Z") =>
    JSON.stringify([{ hora, rota, n, soma, max, erros, faixas }]);

  it("o web grava sem sessão e soma na mesma hora e rota; o que tem mais de 90 dias sai", async () => {
    await app.query("SELECT app.registrar_desempenho($1::jsonb)", [lote(2, 300, 250, [1, 0, 1, 0, 0, 0, 0, 0])]);
    await app.query("SELECT app.registrar_desempenho($1::jsonb)", [lote(1, 900, 900, [0, 0, 0, 0, 1, 0, 0, 0], 1, "2026-11-26T10:59:00Z")]);
    await app.query("SELECT app.registrar_desempenho($1::jsonb)", [lote(1, 10, 10, [1, 0, 0, 0, 0, 0, 0, 0], 0, "2020-01-01T10:00:00Z")]);
    const linhas = (await owner.query("SELECT hora, n, soma_ms::int AS soma, max_ms, erros, faixas FROM desempenho_rotas WHERE rota = $1", [rota])).rows;
    expect(linhas).toEqual([{ hora: new Date("2026-11-26T10:00:00Z"), n: 3, soma: 1200, max_ms: 900, erros: 1, faixas: [1, 0, 1, 0, 1, 0, 0, 0] }]);
    await expect(app.query("SELECT app.registrar_desempenho('{}'::jsonb)")).rejects.toThrow(/Lote de desempenho inválido/);
  });

  it("só quem administra lê a tabela e as consultas lentas", async () => {
    const ler = (quem: string) => withPerson(app, quem, (db) => db.execute(sql`SELECT count(*)::int AS n FROM desempenho_rotas WHERE rota = ${rota}`));
    expect((await ler(admin)).rows[0]).toEqual({ n: 1 });
    expect((await ler(comum)).rows[0]).toEqual({ n: 0 });
    await expect(app.query("INSERT INTO desempenho_rotas (hora, rota, n, soma_ms, max_ms, faixas) VALUES (now(), 'x', 1, 1, 1, '{0,0,0,0,0,0,0,1}')")).rejects.toThrow(/permission denied/);
    await withPerson(app, admin, (db) => db.execute(sql`SELECT * FROM app.consultas_lentas(5)`));
    const recusa = await withPerson(app, comum, (db) => db.execute(sql`SELECT * FROM app.consultas_lentas(5)`)).catch((e: { cause?: Error }) => e.cause?.message);
    expect(recusa).toMatch(/Só quem administra/);
    const ligadas = (await withPerson(app, admin, (db) => db.execute<{ ok: boolean }>(sql`SELECT app.consultas_lentas_ligadas() AS ok`))).rows[0]!.ok;
    expect(typeof ligadas).toBe("boolean");
  });
});
