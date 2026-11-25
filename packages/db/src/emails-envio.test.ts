import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Envio de e-mail (migration 0024): só da própria caixa liberada; assinatura própria; quem vê os envios. */

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

describe.skipIf(!available)("envio de e-mail: permissões", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  const p: Record<string, { id: string; email: string }> = {};

  async function pessoa(nome: string, perfil: string) {
    const email = `${nome}-${tag}@filtrovali.com.br`;
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [email, nome]);
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, perfil]);
    return { id: rows[0]!.id, email };
  }
  const como = (quem: string, q: ReturnType<typeof sql>) => withPerson(app, quem, (db) => db.execute<Record<string, unknown>>(q)).then((r) => r.rows);
  const envio = (de: string, quem: string) =>
    sql`INSERT INTO mail_outbox (person_id, from_address, to_recipients, subject, body, mode)
        VALUES (${quem}::uuid, ${de}, '["cliente@exemplo.invalid"]', '7601 - teste', 'Olá', 'ensaio') RETURNING id`;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    p.lider = await pessoa("lider", "lider_projetos");
    p.semCaixa = await pessoa("semcaixa", "lider_projetos");
    p.gerente = await pessoa("gerente", "gerente");
    await owner.query("INSERT INTO mail_mailboxes (email) VALUES ($1)", [p.lider.email]);
  });

  afterAll(async () => {
    await owner?.query("DELETE FROM mail_mailboxes WHERE email LIKE $1", [`%-${tag}@filtrovali.com.br`]);
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("registra envio só da própria caixa, e só se ela estiver liberada no Omni", async () => {
    expect((await como(p.lider!.id, sql`SELECT app.minha_caixa_email() AS c`))[0]?.c).toBe(p.lider!.email);
    expect(await como(p.lider!.id, envio(p.lider!.email, p.lider!.id))).toHaveLength(1);
    // Caixa de outra pessoa, ou pessoa sem caixa liberada: o banco recusa.
    await expect(como(p.lider!.id, envio(p.gerente!.email, p.lider!.id))).rejects.toThrow();
    await expect(como(p.semCaixa!.id, envio(p.semCaixa!.email, p.semCaixa!.id))).rejects.toThrow();
    await expect(como(p.lider!.id, envio(p.lider!.email, p.gerente!.id))).rejects.toThrow();
  });

  it("assinatura é só da própria pessoa; envios: quem enviou e a gestão", async () => {
    await como(p.lider!.id, sql`INSERT INTO email_signatures (person_id, signature) VALUES (${p.lider!.id}::uuid, 'Líder · Filtrovali')`);
    await expect(como(p.lider!.id, sql`INSERT INTO email_signatures (person_id, signature) VALUES (${p.gerente!.id}::uuid, 'x')`)).rejects.toThrow();
    expect(await como(p.gerente!.id, sql`SELECT 1 FROM email_signatures WHERE person_id = ${p.lider!.id}::uuid`)).toEqual([]);

    const meus = sql`SELECT 1 FROM mail_outbox WHERE person_id = ${p.lider!.id}::uuid`;
    expect((await como(p.lider!.id, meus)).length).toBeGreaterThan(0);
    expect((await como(p.gerente!.id, meus)).length).toBeGreaterThan(0);
    expect(await como(p.semCaixa!.id, meus)).toEqual([]);
  });
});
