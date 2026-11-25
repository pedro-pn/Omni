import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Caixa de e-mail conectada no primeiro login (0058). */

const urls = { owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test" };
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

describe.skipIf(!available)("caixa de e-mail no login", () => {
  let owner: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM mail_mailboxes WHERE email LIKE $1", [`%-${tag}@%`]);
    await owner?.end();
  });
  const caixa = (email: string) => owner.query("SELECT active FROM mail_mailboxes WHERE email = $1", [email]).then((r) => r.rows[0]);

  it("primeiro login cadastra a caixa; desativar a pessoa desliga; caixa desligada pela Administração não volta; contas fictícias ficam de fora", async () => {
    const email = `ana-${tag}@filtrovali.com.br`;
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, 'Ana') RETURNING id", [email]);
    expect(await caixa(email)).toBeUndefined(); // criada pelo Entra, ainda não entrou
    await owner.query("UPDATE people SET last_login_at = now() WHERE id = $1", [rows[0]!.id]);
    expect(await caixa(email)).toEqual({ active: true });
    await owner.query("UPDATE people SET active = false WHERE id = $1", [rows[0]!.id]);
    expect(await caixa(email)).toEqual({ active: false });
    await owner.query("UPDATE people SET active = true WHERE id = $1", [rows[0]!.id]);
    expect(await caixa(email)).toEqual({ active: true }); // reativada: a caixa volta
    // Desligada pela Administração: não volta sozinha.
    await owner.query("UPDATE mail_mailboxes SET active = false WHERE email = $1", [email]);
    await owner.query("UPDATE people SET active = false WHERE id = $1", [rows[0]!.id]);
    await owner.query("UPDATE people SET active = true WHERE id = $1", [rows[0]!.id]);
    expect(await caixa(email)).toEqual({ active: false });
    const ficticia = `teste-${tag}@omni.invalid`;
    await owner.query("INSERT INTO people (email, display_name, last_login_at) VALUES ($1, 'Teste', now())", [ficticia]);
    expect(await caixa(ficticia)).toBeUndefined();
  });
});
