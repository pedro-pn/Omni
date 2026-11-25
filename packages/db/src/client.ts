import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max, application_name: "omni" });
}

/**
 * Acesso do worker (papel omni_worker): sem pessoa na transação, com políticas
 * próprias por tabela. Nunca use no web.
 */
export function createWorkerDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

/**
 * Executa `fn` numa transação em nome de uma pessoa: grava `app.person_id`
 * (local à transação) para as políticas RLS. `null` = sem pessoa (vê nada
 * do que exige login). Nunca use o pool fora daqui para dados de usuário.
 */
export async function withPerson<T>(pool: pg.Pool, personId: string | null, fn: (db: Db) => Promise<T>): Promise<T> {
  if (personId !== null && !UUID.test(personId)) throw new TypeError("personId inválido");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.person_id', $1, true)", [personId ?? ""]);
    const result = await fn(drizzle(client, { schema }));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
