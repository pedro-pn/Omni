import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Agenda da empresa (0067): quem tem perfil lê e edita; um e-mail ou telefone é de um contato só. */

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

describe.skipIf(!available)("agenda da empresa", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  const p: Record<string, string> = {};
  const como = (quem: string, q: ReturnType<typeof sql>) => withPerson(app, quem, (db) => db.execute<Record<string, unknown>>(q)).then((r) => r.rows);
  const erro = (x: Promise<unknown>) => x.then(() => "", (e: { cause?: { message?: string }; message?: string }) => e.cause?.message ?? e.message ?? "");

  beforeAll(async () => {
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    await migrate(urls.owner);
    for (const [k, perfil] of [["vendas", "vendas"], ["operacao", "operacao"], ["sem", null]] as const) {
      const id = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${k}-${tag}@filtrovali.com.br`, k])).rows[0]!.id;
      if (perfil) await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [id, perfil]);
      p[k] = id;
    }
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM contacts WHERE name LIKE $1", [`%${tag}`]);
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("quem tem perfil cadastra e todos com perfil veem; sem perfil, nada; e-mail e telefone de um contato só", async () => {
    const [c] = await como(p.vendas!, sql`INSERT INTO contacts (name, company, created_by) VALUES (${`Compras ${tag}`}, 'Cliente', ${p.vendas}::uuid) RETURNING id`);
    const id = String(c!.id);
    await como(p.vendas!, sql`INSERT INTO contact_identities (contact_id, kind, value) VALUES (${id}::uuid, 'email', ${`compras-${tag}@cliente.com.br`})`);
    // Outra pessoa (outro perfil) vincula o telefone do mesmo contato.
    await como(p.operacao!, sql`INSERT INTO contact_identities (contact_id, kind, value) VALUES (${id}::uuid, 'telefone', '5547999990000')`);
    expect((await como(p.operacao!, sql`SELECT kind FROM contact_identities WHERE contact_id = ${id}::uuid ORDER BY kind`)).map((r) => r.kind)).toEqual(["email", "telefone"]);
    expect(await como(p.sem!, sql`SELECT id FROM contacts WHERE id = ${id}::uuid`)).toEqual([]);
    expect(await erro(como(p.sem!, sql`INSERT INTO contacts (name) VALUES ('x')`))).toMatch(/row-level security/);
    // O mesmo e-mail não vai para outro contato; formato conferido.
    const [d] = await como(p.vendas!, sql`INSERT INTO contacts (name) VALUES (${`Outro ${tag}`}) RETURNING id`);
    expect(await erro(como(p.vendas!, sql`INSERT INTO contact_identities (contact_id, kind, value) VALUES (${String(d!.id)}::uuid, 'email', ${`compras-${tag}@cliente.com.br`})`))).toMatch(/duplicate/);
    expect(await erro(como(p.vendas!, sql`INSERT INTO contact_identities (contact_id, kind, value) VALUES (${id}::uuid, 'email', 'Maiusculo@X.com')`))).toMatch(/check/);
    expect(await erro(como(p.vendas!, sql`INSERT INTO contact_identities (contact_id, kind, value) VALUES (${id}::uuid, 'telefone', '+55 47')`))).toMatch(/check/);
    await owner.query("DELETE FROM contact_identities WHERE value = '5547999990000'");
  });

  it("'Não é a mesma pessoa' (0068): só quem recusou vê a recusa; empresas do Prisma pelo domínio só para quem vê o comercial", async () => {
    await como(p.vendas!, sql`INSERT INTO contact_link_dismissals (email, phone) VALUES (${`x-${tag}@cliente.com.br`}, '5547999990001')`);
    expect(await como(p.vendas!, sql`SELECT email FROM contact_link_dismissals WHERE email = ${`x-${tag}@cliente.com.br`}`)).toHaveLength(1);
    expect(await como(p.operacao!, sql`SELECT email FROM contact_link_dismissals WHERE email = ${`x-${tag}@cliente.com.br`}`)).toEqual([]);
    expect(await erro(como(p.operacao!, sql`INSERT INTO contact_link_dismissals (person_id, email, phone) VALUES (${p.vendas}::uuid, 'y@x.com', '5547999990001')`))).toMatch(/row-level security/);
    await owner.query("INSERT INTO prisma_companies (id, name, email_domains) VALUES ($1, 'Cliente Teste', $2) ON CONFLICT (id) DO UPDATE SET email_domains = EXCLUDED.email_domains", [`emp-${tag}`, [`${tag}.exemplo`]]);
    try {
      expect(await como(p.vendas!, sql`SELECT company_id FROM app.empresas_prisma_do_dominio(${`${tag.toUpperCase()}.exemplo`})`)).toEqual([{ company_id: `emp-${tag}` }]);
      expect(await como(p.operacao!, sql`SELECT company_id FROM app.empresas_prisma_do_dominio(${`${tag}.exemplo`})`)).toEqual([]);
    } finally {
      await owner.query("DELETE FROM prisma_companies WHERE id = $1", [`emp-${tag}`]);
      await owner.query("DELETE FROM contact_link_dismissals WHERE email = $1", [`x-${tag}@cliente.com.br`]);
    }
  });
});
