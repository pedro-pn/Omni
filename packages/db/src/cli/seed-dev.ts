import pg from "pg";

/**
 * Só desenvolvimento: dá os perfis admin e diretoria a um e-mail, criando a
 * pessoa se ela ainda não existir. Uso:
 *   npm run db:seed-dev -- voce@filtrovali.com.br "Seu Nome"
 */

if (process.env.NODE_ENV === "production") {
  console.error("seed-dev não roda em produção.");
  process.exit(1);
}

const [email, name] = process.argv.slice(2);
const url = process.env.DATABASE_URL_OWNER;
if (!url || !email) {
  console.error('Uso: npm run db:seed-dev -- email@filtrovali.com.br "Nome"  (com DATABASE_URL_OWNER definida)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO people (email, display_name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET active = true
     RETURNING id`,
    [email.toLowerCase(), name ?? email.split("@")[0]],
  );
  const id = rows[0]!.id;
  await client.query(
    `INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'admin'), ($1, 'diretoria')
     ON CONFLICT DO NOTHING`,
    [id],
  );
  await client.query("COMMIT");
  console.log(`Pessoa ${email} com perfis admin e diretoria (id ${id}).`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
