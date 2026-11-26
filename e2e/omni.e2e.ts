import { existsSync, readFileSync } from "node:fs";

import pg from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Ponta a ponta do Omni (fumaça): login de desenvolvimento, termo de uso, abas do
 * trilho sem erro de JavaScript, tarefa criada e concluída, Administração fechada
 * para quem não administra e missão aberta no Resumo.
 *
 * Uso: `npm run dev` (AUTH_DEV_LOGIN=on) e, noutro terminal, `npm run e2e`. No CI (E18) roda contra o
 * build de produção com a CSP bloqueando (`e2e/servidor.sh`): violação de CSP conta como erro da tela.
 * Pessoas de teste: e2e.*@omni.invalid (perfis dados aqui pelo dono do banco).
 */

const BASE = process.env.E2E_URL ?? "http://localhost:3000";
const arquivoEnv = new URL("../.env", import.meta.url);
// O ambiente do processo vale sobre o .env (no CI não há .env).
const env: Record<string, string | undefined> = {
  ...Object.fromEntries(
    (existsSync(arquivoEnv) ? readFileSync(arquivoEnv, "utf8") : "")
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
  ),
  ...process.env,
};

let browser: Browser;
let owner: pg.Pool;

async function pessoa(email: string, perfis: string[]) {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO people (email, display_name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET active = true RETURNING id",
    [email, email.split("@")[0]!.replace(/\./g, " ")],
  );
  await owner.query("DELETE FROM person_profiles WHERE person_id = $1", [rows[0]!.id]);
  for (const p of perfis) await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, p]);
  return rows[0]!.id;
}

/** Entra pelo login de desenvolvimento, aceita o termo se pedir e devolve a página com os erros de JS anotados. */
async function entrar(email: string, volta = "/?ver=tarefas"): Promise<{ page: Page; erros: string[] }> {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  const erros: string[] = [];
  page.on("pageerror", (e) => erros.push(e.message));
  // Com CSP_MODO=aplicar, o navegador recusa e avisa no console ("…violates the following Content Security Policy…").
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) erros.push(`CSP: ${m.text().slice(0, 300)}`);
  });
  await page.goto(`/entrar?volta=${encodeURIComponent(volta)}`);
  await page.getByRole("textbox", { name: "E-mail" }).fill(email);
  await page.getByRole("textbox", { name: "Nome" }).fill(email.split("@")[0]!);
  await page.getByRole("button", { name: "Entrar sem Microsoft" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/entrar"));
  if (new URL(page.url()).pathname.startsWith("/termos")) {
    // O aceite só habilita depois de rolar o termo até o fim (de propósito).
    await page.mouse.wheel(0, 30_000);
    await page.waitForTimeout(400);
    const caixa = page.getByRole("checkbox");
    await caixa.uncheck().catch(() => undefined);
    await caixa.check();
    await page.getByRole("button", { name: "Aceitar e continuar" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/termos"));
  }
  await page.getByRole("navigation", { name: "Navegação principal" }).waitFor();
  return { page, erros };
}

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: env.DATABASE_URL_OWNER, max: 2 });
  browser = await chromium.launch();
  const ok = await fetch(`${BASE}/entrar`).then((r) => r.ok).catch(() => false);
  if (!ok) throw new Error(`O Omni não respondeu em ${BASE}: rode "npm run dev" antes.`);
});
afterAll(async () => {
  await owner?.query("DELETE FROM tasks WHERE content LIKE 'e2e %'").catch(() => undefined);
  await Promise.all([browser?.close(), owner?.end()]);
});

describe("Omni de ponta a ponta", () => {
  it("primeiro acesso pede o termo; depois, a caixa (com cada filtro) e as abas do trilho abrem sem erro", async () => {
    const email = `e2e.gestao.${Date.now()}@omni.invalid`;
    await pessoa(email, ["gerente"]);
    const { page, erros } = await entrar(email);
    const trilho = page.getByRole("navigation", { name: "Navegação principal" });
    // Caixa única: um botão no trilho e os filtros (Tudo, WhatsApp, E-mail, Missões, Tarefas).
    await trilho.getByRole("button", { name: "Caixa" }).click();
    const filtros = page.getByRole("tablist", { name: "Filtrar a caixa" });
    for (const filtro of ["Tudo", "WhatsApp", "E-mail", "Missões", "Tarefas"]) {
      await filtros.getByRole("tab", { name: filtro }).click();
      await page.waitForTimeout(1200);
    }
    for (const aba of ["Revisão semanal", "Chamadas"]) {
      await trilho.getByRole("button", { name: aba }).click();
      await page.waitForTimeout(1200);
    }
    expect(erros).toEqual([]);
    // Abrir o WhatsApp sem número mostra o botão; o número (instância do WhatsApp) só nasce no clique.
    await trilho.getByRole("button", { name: "Caixa" }).click();
    await page.getByRole("tablist", { name: "Filtrar a caixa" }).getByRole("tab", { name: "WhatsApp" }).click();
    await page.getByRole("button", { name: "Conectar meu WhatsApp" }).waitFor();
    const numeros = await owner.query("SELECT count(*)::int AS n FROM whatsapp_numbers n JOIN people p ON p.id = n.owner_person_id WHERE p.email = $1", [email]);
    expect(numeros.rows[0].n).toBe(0);
    await owner.query("UPDATE people SET active = false WHERE email = $1", [email]);
  });

  it("tarefa pela captura rápida: cria com data e prioridade e conclui", async () => {
    await pessoa("e2e.tarefas@omni.invalid", ["operacao"]);
    const { page, erros } = await entrar("e2e.tarefas@omni.invalid");
    await page.getByRole("button", { name: /Minhas tarefas/ }).click();
    const titulo = `e2e ${Date.now()}`;
    const captura = page.getByRole("textbox", { name: "Nova tarefa" });
    await captura.fill(`${titulo} amanhã p2`);
    await captura.press("Enter");
    const tarefa = page.getByRole("main").getByText(titulo, { exact: true });
    await tarefa.waitFor();
    const [linha] = (await owner.query("SELECT due_date::text AS d, priority FROM tasks WHERE content = $1", [titulo])).rows;
    expect(linha).toMatchObject({ priority: 2 });
    expect(new Date(`${linha.d}T12:00:00Z`).getTime()).toBeGreaterThan(Date.now() - 24 * 3_600_000);
    await page.getByRole("main").getByRole("button", { name: new RegExp(`Concluir.*${titulo}|Concluir`) }).first().click();
    await expect.poll(async () => (await owner.query("SELECT completed FROM tasks WHERE content = $1", [titulo])).rows[0]?.completed).toBe(true);
    expect(erros).toEqual([]);
  });

  it("Administração fechada para quem não administra; aberta para a diretoria", async () => {
    await pessoa("e2e.operacao@omni.invalid", ["operacao"]);
    const op = await entrar("e2e.operacao@omni.invalid");
    // Só o redirecionamento do servidor (abrir "/" cairia em Conversas e criaria o WhatsApp da pessoa).
    const r = await op.page.request.get("/admin?aba=pessoas", { maxRedirects: 0 });
    expect(r.status()).toBeGreaterThanOrEqual(300);
    expect(r.status()).toBeLessThan(400);
    expect(new URL(r.headers().location ?? "", BASE).pathname).toBe("/");
    // Baixar meus dados (E15): só os da própria pessoa.
    const dados = await op.page.request.get("/api/meus-dados");
    expect(dados.status()).toBe(200);
    expect(dados.headers()["content-disposition"]).toMatch(/attachment; filename="omni-meus-dados-/);
    expect((await dados.json()).pessoa.email).toBe("e2e.operacao@omni.invalid");
    await pessoa("e2e.diretoria@omni.invalid", ["diretoria"]);
    const dir = await entrar("e2e.diretoria@omni.invalid");
    await dir.page.goto("/admin?aba=seguranca");
    await dir.page.getByRole("link", { name: "Segurança" }).waitFor();
    // Desempenho (E19): só para quem administra.
    await pessoa("e2e.admin@omni.invalid", ["admin"]);
    const adm = await entrar("e2e.admin@omni.invalid");
    await adm.page.goto("/admin?aba=desempenho");
    await adm.page.getByRole("heading", { name: "Tempo por rota e ação" }).waitFor();
    await adm.page.getByRole("heading", { name: "Consultas mais lentas no banco" }).waitFor();
    expect([...op.erros, ...dir.erros, ...adm.erros]).toEqual([]);
  });

  it("missão abre no Resumo com o acompanhamento do filtroAPP", async () => {
    // Sem missões sincronizadas (CI), cria uma fictícia; o Resumo abre do mesmo jeito.
    await owner.query(
      `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at)
       SELECT '9901', 'e2e-9901', 'Cliente fictício', true, now() WHERE NOT EXISTS (SELECT 1 FROM missions WHERE is_active)`,
    );
    const [m] = (await owner.query("SELECT id FROM missions WHERE is_active ORDER BY code LIMIT 1")).rows;
    await pessoa("e2e.diretoria@omni.invalid", ["diretoria"]);
    const { page, erros } = await entrar("e2e.diretoria@omni.invalid");
    await page.goto(`/?missao=${m.id}`);
    await page.getByRole("main").getByText("Acompanhamento · filtroAPP").waitFor();
    expect(erros).toEqual([]);
  });
});
