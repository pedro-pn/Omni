import pg from "pg";

/**
 * Staging e produção: dá os perfis admin e diretoria à primeira pessoa (o resto
 * é feito pela tela de Administração). Cria a pessoa se ela ainda não entrou;
 * no primeiro login pela Microsoft, o Omni liga a conta pelo e-mail.
 * Só e-mails @filtrovali.com.br; fica registrado na auditoria. Uso (no servidor):
 *   docker compose ... run --rm migrate node_modules/.bin/tsx packages/db/src/cli/primeiro-admin.ts voce@filtrovali.com.br "Seu Nome"
 */

const [email, nome] = process.argv.slice(2);
const url = process.env.DATABASE_URL_OWNER;
if (!url || !email || !/^[a-z0-9._%+-]+@filtrovali\.com\.br$/i.test(email)) {
  console.error('Uso: primeiro-admin.ts email@filtrovali.com.br "Nome"  (com DATABASE_URL_OWNER definida)');
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
    [email.toLowerCase(), nome ?? email.split("@")[0]],
  );
  const id = rows[0]!.id;
  await client.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'admin'), ($1, 'diretoria') ON CONFLICT DO NOTHING", [id]);
  await client.query(
    "INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata) VALUES (NULL, 'perfil.concedido_no_servidor', 'person', $1, $2)",
    [id, JSON.stringify({ perfis: ["admin", "diretoria"], via: "primeiro-admin" })],
  );
  await client.query("COMMIT");
  console.log(`${email}: perfis admin e diretoria concedidos. Entre pela Microsoft com esse e-mail.`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
