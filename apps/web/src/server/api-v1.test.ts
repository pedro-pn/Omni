import { createHash, randomBytes } from "node:crypto";

import { createPool, migrate, withPerson } from "@omni/db";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashChave, tratarApiV1 } from "./api-v1.ts";
import { hashCodigo, novoCodigo, tratarAutorizacaoPrisma } from "./autorizacao-prisma.ts";

/** API /api/v1 compatível com o Foco e autorização do Prisma, no banco real (omni_test). */

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

type Pessoa = { id: string; email: string };

describe.skipIf(!available)("API /api/v1 compatível com o Foco", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let ana: Pessoa;
  let beto: Pessoa;
  let enzo: Pessoa;
  let projeto: string;
  const t: Record<string, string> = {};
  const chaves: Record<string, string> = {};
  const tag = randomBytes(3).toString("hex");

  async function pessoa(nome: string): Promise<Pessoa> {
    const email = `${nome}-${tag}@filtrovali.com.br`;
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [email, nome]);
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'operacao')", [rows[0]!.id]);
    return { id: rows[0]!.id, email };
  }
  async function chave(p: Pessoa, scopes: string[], extra = ""): Promise<string> {
    const bruta = `foco_live_${randomBytes(24).toString("hex")}`;
    await owner.query(
      `INSERT INTO api_keys (person_id, name, key_prefix, key_hash, scopes, client, revoked_at) VALUES ($1, 'Teste', $2, $3, $4, $5, $6)`,
      [p.id, bruta.slice(0, 18), hashChave(bruta), scopes, scopes.includes("tasks:read:self") ? "prisma" : null, extra === "revogada" ? new Date() : null],
    );
    return bruta;
  }
  async function tarefa(valores: string, params: unknown[]) {
    const { rows } = await owner.query<{ id: string }>(`INSERT INTO tasks ${valores} RETURNING id`, params);
    return rows[0]!.id;
  }
  async function api(metodo: string, caminho: string, k?: string, corpo?: unknown) {
    const r = await tratarApiV1(
      new Request(`http://omni.test/api/v1${caminho}`, {
        method: metodo,
        headers: { ...(k ? { Authorization: `Bearer ${k}` } : {}), "Content-Type": "application/json" },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
      }),
      app,
    );
    return { status: r.status, json: (await r.json()) as Record<string, unknown> & { results?: Array<Record<string, unknown>> } };
  }

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 3);
    [ana, beto, enzo] = [await pessoa("ana"), await pessoa("beto"), await pessoa("enzo")];
    projeto = (await withPerson(app, ana.id, (db) => db.execute<{ id: string }>(sql`SELECT app.criar_projeto_tarefas(${"Obra " + tag}, NULL, NULL) AS id`))).rows[0]!.id;
    await owner.query("INSERT INTO task_project_members (project_id, person_id, added_by) VALUES ($1, $2, $3)", [projeto, beto.id, ana.id]);
    t.daAna = await tarefa("(content, project_id, assignee_person_id, created_by) VALUES ('Da Ana', $1, $2, $2)", [projeto, ana.id]);
    t.doBeto = await tarefa("(content, project_id, assignee_person_id, created_by) VALUES ('Do Beto', $1, $2, $3)", [projeto, beto.id, ana.id]);
    t.caixaAna = await tarefa("(content, owner_person_id, created_by) VALUES ('Caixa da Ana', $1, $1)", [ana.id]);
    t.caixaBeto = await tarefa("(content, owner_person_id, created_by) VALUES ('Caixa do Beto', $1, $1)", [beto.id]);
    chaves.ana = await chave(ana, ["read", "write"]);
    chaves.anaLeitura = await chave(ana, ["read"]);
    chaves.anaPrisma = await chave(ana, ["tasks:read:self"]);
    chaves.beto = await chave(beto, ["read", "write"]);
    chaves.revogada = await chave(enzo, ["read"], "revogada");
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("sem chave, chave errada ou revogada: 401", async () => {
    expect((await api("GET", "/tasks")).json).toEqual({ error: "missing_api_key" });
    expect((await api("GET", "/tasks", "foco_live_nao_existe_nenhuma_chave")).json).toEqual({ error: "invalid_api_key" });
    expect((await api("GET", "/tasks", chaves.revogada)).status).toBe(401);
    expect((await api("GET", "/health")).json).toMatchObject({ status: "ok" });
  });

  it("lista no formato do Foco, com as regras da tela (caixa pessoal só do dono)", async () => {
    const r = await api("GET", "/tasks", chaves.ana);
    const ids = r.json.results!.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([t.daAna, t.doBeto, t.caixaAna]));
    expect(ids).not.toContain(t.caixaBeto);
    const caixa = r.json.results!.find((x) => x.id === t.caixaAna)!;
    expect(caixa).toMatchObject({ content: "Caixa da Ana", project_id: null, assignee_email: ana.email, completed: false, priority: 4 });
    expect(Object.keys(caixa)).toEqual(expect.arrayContaining(["due_date", "due_time", "description", "labels", "created_at"]));
  });

  it("chave do Prisma: só lê as próprias tarefas", async () => {
    const r = await api("GET", `/tasks?assignee_email=${encodeURIComponent(beto.email)}&completed=false&limit=200`, chaves.anaPrisma);
    expect(r.json.results!.map((x) => x.id).sort()).toEqual([t.daAna, t.caixaAna].sort());
    expect((await api("GET", `/tasks/${t.doBeto}`, chaves.anaPrisma)).status).toBe(404);
    expect((await api("GET", `/tasks/${t.daAna}`, chaves.anaPrisma)).json).toMatchObject({ id: t.daAna, assignee_email: ana.email });
    expect((await api("POST", "/tasks", chaves.anaPrisma, { content: "x" })).json).toEqual({ error: "prisma_read_only" });
    expect((await api("GET", "/projects", chaves.anaPrisma)).status).toBe(403);
  });

  it("escrita: precisa de escopo, respeita membros e valida a repetição", async () => {
    expect((await api("POST", "/tasks", chaves.anaLeitura, { content: "x" })).json).toEqual({ error: "missing_write_scope" });
    const caixa = await api("POST", "/tasks", chaves.ana, { content: "Ligar para o cliente", due_date: "2026-11-10", labels: ["cliente"] });
    expect(caixa.status).toBe(201);
    expect(caixa.json).toMatchObject({ project_id: null, assignee_email: ana.email, labels: "cliente", due_date: "2026-11-10" });
    const delegada = await api("POST", "/tasks", chaves.ana, { content: "Medir", project_id: projeto, assignee_email: beto.email });
    expect(delegada.json).toMatchObject({ assignee_email: beto.email });
    expect((await api("POST", "/tasks", chaves.ana, { content: "Medir", project_id: projeto, assignee_email: enzo.email })).status).toBe(403);
    expect((await api("POST", "/tasks", chaves.ana, { content: "x", recurrence: "quando der" })).json).toEqual({ error: "invalid_recurrence" });
    expect((await api("POST", "/tasks", chaves.ana, { description: "sem título" })).json).toEqual({ error: "content_required" });
    expect((await api("PATCH", `/tasks/${t.daAna}`, chaves.beto, { priority: 1 })).json).toEqual({ error: "forbidden" });
  });

  it("concluir tarefa que repete avança a data; concluir e reabrir; comentar e ver o histórico", async () => {
    // Data no futuro: a próxima ocorrência não depende do dia em que o teste roda.
    const rep = await api("POST", "/tasks", chaves.ana, { content: "Relatório semanal", due_date: "2099-01-05", recurrence: "toda segunda" });
    const fechada = await api("POST", `/tasks/${rep.json.id}/close`, chaves.ana);
    expect(fechada.json).toMatchObject({ completed: false, due_date: "2099-01-12", recurrence: "weekly:1" });

    expect((await api("POST", `/tasks/${t.daAna}/close`, chaves.ana)).json).toMatchObject({ completed: true });
    expect((await api("POST", `/tasks/${t.daAna}/reopen`, chaves.ana)).json).toMatchObject({ completed: false });

    const c = await api("POST", "/comments", chaves.beto, { task_id: t.daAna, content: "Combinado" });
    expect(c.json).toMatchObject({ task_id: t.daAna, user_id: beto.id, content: "Combinado" });
    expect((await api("GET", `/comments?task_id=${t.daAna}`, chaves.ana)).json.results).toHaveLength(1);
    const h = await api("GET", `/activity?task_id=${t.daAna}`, chaves.ana);
    expect(h.json.results!.map((x) => x.action)).toEqual(expect.arrayContaining(["concluida", "reaberta"]));
  });

  it("projetos e seções", async () => {
    const p = await api("POST", "/projects", chaves.beto, { name: "Projeto do Beto", color: "#336699" });
    expect(p.status).toBe(201);
    expect((await api("GET", `/projects/${p.json.id}`, chaves.ana)).json).toEqual({ error: "project_not_found" });
    const s = await api("POST", "/sections", chaves.beto, { project_id: p.json.id, name: "Campo" });
    expect(s.json).toMatchObject({ name: "Campo", project_id: p.json.id });
    expect((await api("DELETE", `/projects/${p.json.id}`, chaves.beto)).json.archived_at).not.toBeNull();
  });

  describe("autorização do Prisma (PKCE)", () => {
    const verificador = randomBytes(40).toString("base64url");
    const desafio = createHash("sha256").update(verificador).digest("base64url");
    const redirect = "https://prismacrm.filtrovali.com.br/";
    const trocar = (corpo: Record<string, unknown>) =>
      tratarAutorizacaoPrisma(new Request("http://omni.test/api/prisma-authorization/token", { method: "POST", body: JSON.stringify(corpo) }), app, "token");
    const emitir = async () => {
      const codigo = novoCodigo();
      await withPerson(app, ana.id, (db) => db.execute(sql`SELECT app.emitir_codigo_prisma(${hashCodigo(codigo)}, ${desafio}, ${ana.email})`));
      return codigo;
    };

    it("troca uma vez, com o verificador certo, e a chave só lê as próprias tarefas até ser revogada", async () => {
      const codigo = await emitir();
      const base = { client_id: "prisma", grant_type: "authorization_code", code: codigo, redirect_uri: redirect };
      expect((await (await trocar({ ...base, code_verifier: randomBytes(40).toString("base64url") })).json()).error).toBe("invalid_grant");
      const ok = (await (await trocar({ ...base, code_verifier: verificador })).json()) as Record<string, string>;
      expect(ok).toMatchObject({ token_type: "Bearer", scope: "tasks:read:self", email: ana.email });
      expect(ok.access_token).toMatch(/^foco_live_[A-Za-z0-9_-]{20,200}$/);
      expect((await (await trocar({ ...base, code_verifier: verificador })).json()).error).toBe("invalid_grant"); // uso único

      expect((await api("GET", "/tasks", ok.access_token)).status).toBe(200);
      expect((await api("POST", "/tasks", ok.access_token, { content: "x" })).status).toBe(403);
      const rev = await tratarAutorizacaoPrisma(
        new Request("http://omni.test/api/prisma-authorization/revoke", { method: "POST", body: JSON.stringify({ token: ok.access_token }) }),
        app,
        "revoke",
      );
      expect(await rev.json()).toEqual({ revoked: true });
      expect((await api("GET", "/tasks", ok.access_token)).status).toBe(401);
    });

    it("só emite código para quem está logado com o mesmo e-mail", async () => {
      await expect(
        withPerson(app, beto.id, (db) => db.execute(sql`SELECT app.emitir_codigo_prisma(${hashCodigo(novoCodigo())}, ${desafio}, ${ana.email})`)),
      ).rejects.toThrow();
    });

    it("recusa retorno, cliente ou origem diferentes", async () => {
      const codigo = await emitir();
      const base = { client_id: "prisma", grant_type: "authorization_code", code: codigo, code_verifier: verificador };
      expect((await (await trocar({ ...base, redirect_uri: "https://evil.test/" })).json()).error).toBe("invalid_grant");
      expect((await (await trocar({ ...base, redirect_uri: redirect, client_id: "outro" })).json()).error).toBe("invalid_request");
      const deFora = await tratarAutorizacaoPrisma(
        new Request("http://omni.test/api/prisma-authorization/token", { method: "POST", headers: { origin: "https://evil.test" }, body: "{}" }),
        app,
        "token",
      );
      expect(deFora.status).toBe(403);
    });
  });
});
