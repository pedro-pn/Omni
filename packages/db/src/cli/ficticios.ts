import pg from "pg";

/**
 * Só desenvolvimento: cria uma pessoa fictícia para cada função da empresa e a
 * coloca na função, para testar a IA sem gente de verdade. As funções vêm da
 * tabela `functions` (nada fixo aqui). E-mails em `@omni.invalid`, que não
 * existe. Função já ocupada por alguém real fica como está.
 *
 *   npm run db:ficticios               cria e atribui
 *   npm run db:ficticios -- --remover  tira das funções e desativa
 *
 * Para agir como uma delas: login de desenvolvimento com o e-mail mostrado.
 */

const DOMINIO = "omni.invalid";

if (process.env.NODE_ENV === "production") {
  console.error("ficticios não roda em produção.");
  process.exit(1);
}
const url = process.env.DATABASE_URL_OWNER;
if (!url) {
  console.error("Defina DATABASE_URL_OWNER (o .env da raiz já tem).");
  process.exit(1);
}

const remover = process.argv.includes("--remover");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  if (remover) {
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM people WHERE email LIKE '%@' || $1`, [DOMINIO]);
    const ids = rows.map((r) => r.id);
    await client.query(`DELETE FROM function_assignments WHERE person_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM person_profiles WHERE person_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM sessions WHERE person_id = ANY($1)`, [ids]);
    await client.query(`UPDATE people SET active = false WHERE id = ANY($1)`, [ids]);
    console.log(`${ids.length} pessoa(s) fictícia(s) fora das funções e desativadas.`);
  } else {
    const { rows: funcoes } = await client.query<{ code: string; name: string }>(`SELECT code, name FROM functions ORDER BY name`);
    const hoje = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
    for (const f of funcoes) {
      const email = `teste.${f.code.replaceAll("_", "-")}@${DOMINIO}`;
      const {
        rows: [pessoa],
      } = await client.query<{ id: string }>(
        `INSERT INTO people (email, display_name, job_title) VALUES ($1, $2, 'Pessoa fictícia (teste)')
         ON CONFLICT (email) DO UPDATE SET active = true RETURNING id`,
        [email, `Teste ${f.name}`],
      );
      await client.query(`INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'operacao') ON CONFLICT DO NOTHING`, [pessoa!.id]);

      const { rows: ocupantes } = await client.query<{ person_id: string; display_name: string }>(
        `SELECT a.person_id, p.display_name FROM function_assignments a JOIN people p ON p.id = a.person_id
          WHERE a.function_code = $1 AND p.active AND a.starts_on <= ${hoje} AND (a.ends_on IS NULL OR a.ends_on >= ${hoje})`,
        [f.code],
      );
      if (ocupantes.some((o) => o.person_id === pessoa!.id)) {
        console.log(`${f.name.padEnd(28)} já com ${email}`);
      } else if (ocupantes.length) {
        console.log(`${f.name.padEnd(28)} ocupada por ${ocupantes.map((o) => o.display_name).join(", ")} — mantida`);
      } else {
        await client.query(`INSERT INTO function_assignments (function_code, person_id, starts_on) VALUES ($1, $2, ${hoje})`, [
          f.code,
          pessoa!.id,
        ]);
        console.log(`${f.name.padEnd(28)} → ${email}`);
      }
    }
    console.log("\nEntre com o login de desenvolvimento usando um desses e-mails para responder como a função.");
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
