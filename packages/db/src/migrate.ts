import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

/**
 * Executor de migrations em SQL puro.
 *
 * - Aplica `migrations/NNNN_nome.sql` em ordem, cada uma numa transação.
 * - Guarda nome e sha256 em `schema_migrations`; se um arquivo já aplicado
 *   mudar, para com erro (migration aplicada não se edita — cria-se outra).
 * - Usa advisory lock para dois deploys não migrarem ao mesmo tempo.
 *
 * Deve rodar com o papel dono (DATABASE_URL_OWNER).
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 4_204_820_301; // número qualquer, fixo para o Omni

export type MigrationResult = { applied: string[]; skipped: string[] };

export async function migrate(connectionString: string, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f)).sort();
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = done.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(`A migration ${file} foi alterada depois de aplicada. Crie uma nova migration.`);
        }
        result.skipped.push(file);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
        result.applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Falha na migration ${file}: ${(error as Error).message}`, { cause: error });
      }
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
