import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Retenção por tipo de dado (migration 0066): ensaio só conta; real apaga só o vencido. */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  worker: process.env.TEST_DATABASE_URL_WORKER ?? "postgres://omni_worker:omni_worker_dev@localhost:5433/omni_test",
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

describe.skipIf(!available)("retenção", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let app: pg.Pool;
  let pessoa = "";
  const tag = randomUUID().slice(0, 8);
  const antiga = randomBytes(32);
  const recente = randomBytes(32);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    app = createPool(urls.app, 2);
    pessoa = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, 'Retenção') RETURNING id", [`ret-${tag}@filtrovali.com.br`])).rows[0]!.id;
    await owner.query("INSERT INTO sessions (token_hash, person_id, expires_at) VALUES ($1, $3, now() - interval '40 days'), ($2, $3, now() + interval '1 day')", [antiga, recente, pessoa]);
    await owner.query(
      `INSERT INTO notifications (person_id, kind, title, created_at, read_at) VALUES
         ($1, 'teste_push', 'lido-velho', now() - interval '200 days', now() - interval '199 days'),
         ($1, 'teste_push', 'lido-novo', now() - interval '10 days', now()),
         ($1, 'teste_push', 'nao-lido-velho', now() - interval '400 days', NULL)`,
      [pessoa],
    );
    await owner.query("INSERT INTO llm_calls (purpose, model, outcome, data_ids, created_at) VALUES ('teste', 'm', 'ok', $1, now() - interval '400 days'), ('teste', 'm', 'ok', $1, now())", [JSON.stringify({ tag })]);
    await owner.query(
      `INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, at) VALUES
         ($1, 'arquivo.baixado', 'sharepoint', 'velho', now() - interval '400 days'),
         ($1, 'arquivo.baixado', 'sharepoint', 'novo', now()),
         ($1, 'perfil.concedido', 'pessoa', 'velho', now() - interval '400 days')`,
      [pessoa],
    );
    await owner.query("INSERT INTO terms_acceptances (person_id, versao, texto_sha256, aceito_em, ip, user_agent) VALUES ($1, '2020-01-01', $2, now() - interval '3 years', '10.0.0.1', 'Navegador')", [pessoa, "a".repeat(64)]);
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM notifications WHERE person_id = $1", [pessoa]);
    await owner?.query("DELETE FROM llm_calls WHERE data_ids->>'tag' = $1", [tag]);
    await Promise.all([owner?.end(), worker?.end(), app?.end()]);
  });

  const estado = async () => ({
    sessoes: (await owner.query("SELECT count(*)::int AS n FROM sessions WHERE person_id = $1", [pessoa])).rows[0].n,
    avisos: (await owner.query("SELECT title FROM notifications WHERE person_id = $1 ORDER BY title", [pessoa])).rows.map((r) => r.title),
    ia: (await owner.query("SELECT count(*)::int AS n FROM llm_calls WHERE data_ids->>'tag' = $1", [tag])).rows[0].n,
    auditoria: (await owner.query("SELECT action || ':' || entity_id AS a FROM audit_log WHERE actor_person_id = $1 ORDER BY 1", [pessoa])).rows.map((r) => r.a),
    termo: (await owner.query("SELECT ip, user_agent, texto_sha256 FROM terms_acceptances WHERE person_id = $1", [pessoa])).rows[0],
  });

  it("ensaio só conta; real apaga só o vencido e anonimiza o termo; o resto da auditoria fica", async () => {
    const antes = await estado();
    const contagem = (await worker.query("SELECT app.aplicar_retencao(false) AS r")).rows[0].r;
    expect(contagem.aplicado).toBe(false);
    expect(contagem.sessoes).toBeGreaterThanOrEqual(1);
    expect(await estado()).toEqual(antes);

    const r = (await worker.query("SELECT app.aplicar_retencao(true) AS r")).rows[0].r;
    expect(r.aplicado).toBe(true);
    const depois = await estado();
    expect(depois.sessoes).toBe(1);
    expect(depois.avisos).toEqual(["lido-novo"]);
    expect(depois.ia).toBe(1);
    expect(depois.auditoria).toEqual(["arquivo.baixado:novo", "perfil.concedido:velho"]);
    expect(depois.termo).toEqual({ ip: null, user_agent: null, texto_sha256: "a".repeat(64) });
  });

  it("fora da retenção a auditoria continua só de inserção; o web não chama a retenção", async () => {
    await expect(owner.query("DELETE FROM audit_log WHERE actor_person_id = $1 AND action = 'arquivo.baixado'", [pessoa])).rejects.toThrow(/somente inserção/);
    await expect(app.query("SELECT app.aplicar_retencao(true)")).rejects.toThrow(/permission denied/);
  });
});
