import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";
import { resolveSessionComTermos } from "./sessions.ts";

/** Termo de uso (0051): a sessão só abre o Omni com a versão atual aceita; prova do aceite com RLS. */

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
const SHA = "a".repeat(64);

describe.skipIf(!available)("termo de uso", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  const p: Record<string, string> = {};
  const tokens: Record<string, string> = {};

  async function pessoa(nome: string, perfil?: string) {
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@filtrovali.com.br`, nome]);
    if (perfil) await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, perfil]);
    tokens[nome] = randomUUID();
    await owner.query("INSERT INTO sessions (token_hash, person_id, expires_at) VALUES ($1, $2, now() + interval '1 day')", [
      createHash("sha256").update(tokens[nome]!, "utf8").digest(),
      rows[0]!.id,
    ]);
    return rows[0]!.id;
  }
  const aceitar = (quem: string, versao: string) =>
    withPerson(app, quem, (db) => db.execute<{ ok: boolean }>(sql`SELECT app.aceitar_termos(${versao}, ${SHA}, '203.0.113.7'::inet, 'Teste') AS ok`)).then((r) => r.rows[0]!.ok);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    p.ana = await pessoa("ana");
    p.bia = await pessoa("bia");
    p.admin = await pessoa("admin", "admin");
  });
  afterAll(async () => {
    await owner?.end();
    await app?.end();
  });

  it("sem o aceite da versão atual a sessão fica pendente; aceita, abre; versão nova pede de novo", async () => {
    expect(await resolveSessionComTermos(app, tokens.ana, "2026-11-11")).toEqual({ personId: p.ana, termosPendentes: true, senhaPendente: false, acesso: "microsoft" });
    expect(await aceitar(p.ana!, "2026-11-11")).toBe(true);
    expect(await aceitar(p.ana!, "2026-11-11")).toBe(true); // repetir não duplica
    expect(await resolveSessionComTermos(app, tokens.ana, "2026-11-11")).toEqual({ personId: p.ana, termosPendentes: false, senhaPendente: false, acesso: "microsoft" });
    expect(await resolveSessionComTermos(app, tokens.ana, "2027-01-01")).toEqual({ personId: p.ana, termosPendentes: true, senhaPendente: false, acesso: "microsoft" });
    expect(await resolveSessionComTermos(app, "token-que-nao-existe", "2026-11-11")).toBeNull();
    const audit = await owner.query("SELECT count(*)::int n FROM audit_log WHERE action = 'termos.aceitos' AND entity_id = $1", [p.ana]);
    expect(audit.rows[0].n).toBe(1);
    const [a] = (await owner.query("SELECT texto_sha256, host(ip) ip, user_agent FROM terms_acceptances WHERE person_id = $1", [p.ana])).rows;
    expect(a).toEqual({ texto_sha256: SHA, ip: "203.0.113.7", user_agent: "Teste" });
    // Pessoa desativada: sem sessão, mesmo com o termo aceito.
    await owner.query("UPDATE people SET active = false WHERE id = $1", [p.ana]);
    expect(await resolveSessionComTermos(app, tokens.ana, "2026-11-11")).toBeNull();
    await owner.query("UPDATE people SET active = true WHERE id = $1", [p.ana]);
  });

  it("cada um vê os próprios aceites; Administração vê todos; ninguém grava direto; versão inválida recusada", async () => {
    await aceitar(p.bia!, "2026-11-11");
    const ver = (quem: string) => withPerson(app, quem, (db) => db.execute<{ person_id: string }>(sql`SELECT person_id FROM terms_acceptances WHERE person_id IN (${p.ana}::uuid, ${p.bia}::uuid)`)).then((r) => r.rows.map((x) => x.person_id).sort());
    expect(await ver(p.ana!)).toEqual([p.ana]);
    expect(await ver(p.admin!)).toEqual([p.ana, p.bia].sort());
    const erro = (q: Promise<unknown>) => q.then(() => "", (e: Error & { cause?: Error }) => `${e.message} ${e.cause?.message ?? ""}`);
    expect(
      await erro(withPerson(app, p.bia!, (db) => db.execute(sql`INSERT INTO terms_acceptances (person_id, versao, texto_sha256) VALUES (${p.ana}::uuid, '2030-01-01', ${SHA})`))),
    ).toMatch(/permission denied/);
    expect(await erro(aceitar(p.bia!, "qualquer"))).toMatch(/check constraint/);
    // Sem pessoa na sessão do banco, aceitar não grava nada.
    expect((await app.query("SELECT app.aceitar_termos('2026-11-11', $1, NULL, NULL) AS ok", [SHA])).rows[0].ok).toBe(false);
  });
});
