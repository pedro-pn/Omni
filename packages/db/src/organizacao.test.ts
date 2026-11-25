import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Pastas e arquivo pessoais (0059): só da própria pessoa; pasta da mesma pessoa e do mesmo tipo. */

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

describe.skipIf(!available)("organização pessoal", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  let ana = "";
  let bia = "";
  const como = (quem: string, q: ReturnType<typeof sql>) => withPerson(app, quem, (db) => db.execute<Record<string, unknown>>(q)).then((r) => r.rows);
  const erro = (q: Promise<unknown>) => q.then(() => "", (e: Error & { cause?: Error }) => `${e.message} ${e.cause?.message ?? ""}`);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    const nova = async (n: string) => (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${n}-${tag}@filtrovali.com.br`, n])).rows[0]!.id;
    ana = await nova("ana");
    bia = await nova("bia");
  });
  afterAll(async () => {
    await owner?.end();
    await app?.end();
  });

  it("cada um cria e vê só as próprias pastas; item só em pasta própria e do mesmo tipo; apagar a pasta solta os itens", async () => {
    const [p] = await como(ana, sql`INSERT INTO pastas_pessoais (person_id, tipo, nome) VALUES (${ana}::uuid, 'missao', 'Obras de SC') RETURNING id`);
    const pasta = String(p!.id);
    expect(await como(bia, sql`SELECT id FROM pastas_pessoais WHERE id = ${pasta}::uuid`)).toEqual([]);
    expect(await erro(como(bia, sql`INSERT INTO pastas_pessoais (person_id, tipo, nome) VALUES (${ana}::uuid, 'missao', 'Invasão')`))).toMatch(/row-level security/);
    const item = randomUUID();
    await como(ana, sql`INSERT INTO organizacao_pessoal (person_id, tipo, item_id, pasta_id) VALUES (${ana}::uuid, 'missao', ${item}::uuid, ${pasta}::uuid)`);
    // A pasta da Ana não serve para a Bia nem para conversas.
    expect(await erro(como(bia, sql`INSERT INTO organizacao_pessoal (person_id, tipo, item_id, pasta_id) VALUES (${bia}::uuid, 'missao', ${item}::uuid, ${pasta}::uuid)`))).toMatch(/foreign key|violates/);
    expect(await erro(como(ana, sql`INSERT INTO organizacao_pessoal (person_id, tipo, item_id, pasta_id) VALUES (${ana}::uuid, 'conversa', ${item}::uuid, ${pasta}::uuid)`))).toMatch(/foreign key|violates/);
    // O mesmo item pode estar arquivado para a Bia e numa pasta para a Ana.
    await como(bia, sql`INSERT INTO organizacao_pessoal (person_id, tipo, item_id, arquivado_em) VALUES (${bia}::uuid, 'missao', ${item}::uuid, now())`);
    expect(await como(ana, sql`SELECT person_id FROM organizacao_pessoal WHERE item_id = ${item}::uuid`)).toEqual([{ person_id: ana }]);
    await como(ana, sql`DELETE FROM pastas_pessoais WHERE id = ${pasta}::uuid`);
    expect(await como(ana, sql`SELECT pasta_id FROM organizacao_pessoal WHERE item_id = ${item}::uuid`)).toEqual([{ pasta_id: null }]);
  });
});
