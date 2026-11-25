import { createHash, createHmac, randomUUID } from "node:crypto";

import { createPool, migrate } from "@omni/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FonteFoco, Linha } from "./fonte.ts";
import { importarFoco, relatorioEmTexto } from "./importar.ts";
import { uuidDe } from "./transformar.ts";

/** Migração do Foco no banco real (omni_test), com um Foco de mentira. Missão 7603 e e-mails @foco-teste.invalid são deste arquivo. */

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

const id = () => randomUUID();
const tag = randomUUID().slice(0, 6);
const U = { ana: id(), bruno: id(), fora: id() };
const E = { ana: `ana-${tag}@foco-teste.invalid`, bruno: `bruno-${tag}@foco-teste.invalid`, fora: `fora-${tag}@outro.invalid` };
const P = { obra: id(), geral: id(), orfao: id() };
const S = { s1: id() };
const T = { t1: id(), t2: id(), t3: id(), t4: id(), t5: id(), t6: id(), t7: id() };
const C = { c1: id(), c2: id() };
const K = { leitura: id(), revogada: id(), codex: id(), prisma: id() };
const TOKEN = `foco_live_${"ab".repeat(24)}`;
const TOKEN_PRISMA = `foco_live_${"cd".repeat(24)}`;
const hex = (t: string) => `\\x${createHash("sha256").update(t).digest("hex")}`;
const FEED = { id: id(), criado: "2026-10-01T12:00:00.123456+00:00" };
const ANEXO = { id: id(), bytes: new TextEncoder().encode("conteúdo do anexo") };
const MSG = { m1: id(), m2: id() };

function focoDeMentira(): Record<string, Linha[]> {
  const agora = "2026-11-01T10:00:00+00:00";
  return {
    members: [],
    workspace_members: [
      { workspace_id: "w", user_id: U.ana, email: E.ana, role: "owner", joined_at: agora },
      { workspace_id: "w", user_id: U.bruno, email: E.bruno, role: "member", joined_at: agora },
      { workspace_id: "w", user_id: U.fora, email: E.fora, role: "member", joined_at: agora },
    ],
    projects: [
      { id: P.obra, name: "Obra 7603 Porto", color: "#abc", description: "x", created_by: U.ana, created_at: agora, is_general: false, folder_id: "pasta", parent_project_id: null, archived_at: null },
      { id: P.geral, name: "Geral", color: "#5b7cfa", description: "", created_by: U.ana, created_at: agora, is_general: true, folder_id: null, parent_project_id: null, archived_at: null },
      { id: P.orfao, name: "De quem saiu", color: "#5b7cfa", description: "", created_by: U.fora, created_at: agora, is_general: false },
    ],
    project_members: [
      { project_id: P.obra, user_id: U.ana, role: "owner", added_at: agora, added_by: U.ana },
      { project_id: P.obra, user_id: U.fora, role: "member", added_at: agora, added_by: U.ana },
      { project_id: P.orfao, user_id: U.fora, role: "owner", added_at: agora, added_by: U.fora },
    ],
    pending_project_members: [],
    sections: [{ id: S.s1, project_id: P.obra, name: "Mobilização", position: 1.4, created_at: agora }],
    tasks: [
      { id: T.t1, content: "Enviar cronograma", project_id: P.obra, section_id: S.s1, assignee_email: E.bruno.toUpperCase(), labels: '["obra"]', tag: "urgente", priority: 1, due_date: "2026-11-10", created_by: U.ana, created_at: agora, completed: false, position: 2 },
      { id: T.t2, content: "Sub 1", project_id: P.obra, parent_task_id: T.t1, due_date: "2026-11-10", created_by: U.ana, created_at: agora, completed: false, position: 0 },
      { id: T.t3, content: "Sub da sub", project_id: P.obra, parent_task_id: T.t2, due_date: "2026-11-10", created_by: U.ana, created_at: agora, completed: false, position: 0 },
      { id: T.t4, content: "Minha sem data", project_id: null, owner_user_id: U.ana, due_date: null, created_by: U.ana, created_at: "2026-10-05T01:30:00+00:00", completed: false, position: 0 },
      { id: T.t5, content: "Da caixa de quem saiu", project_id: null, owner_user_id: U.fora, due_date: "2026-11-10", created_by: U.fora, created_at: agora, completed: false },
      { id: T.t6, content: "No projeto órfão", project_id: P.orfao, due_date: "2026-11-10", created_by: U.fora, created_at: agora, completed: false },
      { id: T.t7, content: "Feita", project_id: P.geral, due_date: "2026-11-01", created_by: U.bruno, created_at: agora, completed: true, completed_at: "2026-11-02T10:00:00+00:00" },
    ],
    comments: [
      { id: C.c1, task_id: T.t1, user_id: U.bruno, content: "Mandei ontem", created_at: agora },
      { id: C.c2, task_id: T.t1, user_id: U.fora, content: "Ok", created_at: agora },
    ],
    comment_mentions: [{ comment_id: C.c1, user_id: U.ana }],
    comment_reactions: [
      { comment_id: C.c1, user_id: U.ana, emoji: "👍", created_at: agora },
      { comment_id: C.c1, user_id: U.ana, emoji: "🔥", created_at: agora },
    ],
    activity_log: [{ id: id(), task_id: T.t1, actor_user_id: U.ana, action: "task_created", summary: "Criou a tarefa", metadata: {}, created_at: agora }],
    attachments: [{ id: ANEXO.id, task_id: T.t1, filename: "foto.jpg", content_type: "image/jpeg", size: ANEXO.bytes.byteLength, object_key: `w/${T.t1}/foto.jpg`, uploaded_by: U.ana, created_at: agora }],
    saved_filters: [{ id: id(), user_id: U.ana, name: "Urgentes", query: "p1", color: "#ff0000", favorite: true, created_at: agora }],
    api_keys: [
      { id: K.leitura, created_by: U.ana, name: "Automação Filtrovali", key_prefix: TOKEN.slice(0, 18), key_hash: hex(TOKEN), scopes: ["read"], created_at: agora, revoked_at: null },
      { id: K.revogada, created_by: U.ana, name: "Teste antigo", key_prefix: "foco_live_x", key_hash: hex("x"), scopes: ["read"], created_at: agora, revoked_at: agora },
      { id: K.codex, created_by: U.ana, name: "Chave codex", key_prefix: "foco_live_y", key_hash: hex("y"), scopes: ["read", "write"], created_at: agora, revoked_at: null },
      { id: K.prisma, created_by: U.bruno, name: "Prisma — atividades somente leitura", key_prefix: TOKEN_PRISMA.slice(0, 18), key_hash: hex(TOKEN_PRISMA), scopes: ["read"], created_at: agora, revoked_at: null },
    ],
    prisma_authorization_grants: [{ key_id: K.prisma, user_id: U.bruno }],
    apple_calendar_feeds: [{ id: FEED.id, user_id: U.ana, created_at: FEED.criado, workspace_id: "w" }],
    user_notification_settings: [{ user_id: U.ana, email_due_reminders: false, email_task_assigned: true, email_mentions: true, email_task_completed: true }],
    project_messages: [
      { id: MSG.m1, project_id: P.obra, user_id: U.ana, content: "Bom dia, time", created_at: "2026-10-20T11:00:00+00:00" },
      { id: MSG.m2, project_id: P.obra, user_id: U.bruno, content: "Bom dia @Ana", created_at: "2026-10-21T11:00:00+00:00" },
    ],
    project_message_mentions: [{ message_id: MSG.m2, user_id: U.ana }],
    notifications: [{ id: id() }, { id: id() }],
  };
}

function fonte(dados: Record<string, Linha[]>): FonteFoco {
  return {
    tabela: async (t) => dados[t] ?? null,
    usuarios: async () => [
      { id: U.ana, email: E.ana },
      { id: U.bruno, email: E.bruno },
      { id: U.fora, email: E.fora },
    ],
    arquivo: async () => ANEXO.bytes,
  };
}

describe.skipIf(!available)("migração do Foco", () => {
  let owner: pg.Pool;
  let ana = "";
  let bruno = "";
  let missao = "";
  const enviados: string[] = [];
  const enviarArquivo = async (_d: string, caminho: string, b: Uint8Array) => {
    enviados.push(caminho);
    return { id: `item-${enviados.length}`, tamanho: b.byteLength };
  };
  const op = { enviarArquivo, driveId: "drive-teste", pastaAnexos: "Tarefas-teste", pularChaves: ["chave CODEX"], conversas: ["Obra 7603 Porto"] };
  const tarefas = async () => (await owner.query("SELECT id, project_id, owner_person_id, parent_task_id, assignee_person_id, due_date::text, labels, section_id FROM tasks WHERE id = ANY($1::uuid[])", [Object.values(T)])).rows;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 3);
    await owner.query("DELETE FROM missions WHERE code = '7603'");
    ana = (await owner.query("INSERT INTO people (email, display_name) VALUES ($1, 'Ana') RETURNING id", [E.ana])).rows[0].id;
    bruno = (await owner.query("INSERT INTO people (email, display_name) VALUES ($1, 'Bruno') RETURNING id", [E.bruno])).rows[0].id;
    missao = (await owner.query("INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ('7603', $1, 'Porto', true, now()) RETURNING id", [`foco-${tag}`])).rows[0].id;
  });
  afterAll(async () => {
    if (!owner) return;
    await owner.query("DELETE FROM task_projects WHERE id = ANY($1::uuid[])", [Object.values(P)]);
    await owner.query("DELETE FROM tasks WHERE id = ANY($1::uuid[]) OR owner_person_id = ANY($2::uuid[])", [Object.values(T), [ana, bruno]]);
    await owner.query("DELETE FROM api_keys WHERE person_id = ANY($1::uuid[])", [[ana, bruno]]);
    await owner.query("DELETE FROM notifications WHERE person_id = ANY($1::uuid[])", [[ana, bruno]]);
    await owner.query("DELETE FROM missions WHERE id = $1", [missao]);
    await owner.query("DELETE FROM people WHERE id = ANY($1::uuid[])", [[ana, bruno]]);
    await owner.end();
  });

  it("ensaio: confere tudo e não grava nada", async () => {
    const r = await importarFoco(owner, fonte(focoDeMentira()), { ...op, real: false });
    expect(r.conferencia.tarefas).toEqual({ esperado: 6, noOmni: 6 }); // t1–t4, t7 e a conversa do projeto (t5 e t6 não migram)
    expect(r.anexos).toMatchObject({ conferidos: 1, copiados: 0 });
    expect(enviados).toEqual([]);
    expect(await tarefas()).toEqual([]);
    expect(relatorioEmTexto(r)).toContain("ENSAIO");
  });

  it("carga real: mesmos ids, regras do Omni, sem histórico nem avisos dos gatilhos", async () => {
    const r = await importarFoco(owner, fonte(focoDeMentira()), { ...op, real: true });
    expect(Object.values(r.conferencia).every((c) => c.esperado === c.noOmni)).toBe(true);
    const ts = new Map((await tarefas()).map((t) => [t.id, t]));
    expect([...ts.keys()].sort()).toEqual([T.t1, T.t2, T.t3, T.t4, T.t7].sort()); // t5 (caixa de quem saiu) e t6 (projeto órfão) não
    expect(ts.get(T.t1)).toMatchObject({ project_id: P.obra, assignee_person_id: bruno, labels: ["urgente", "obra"], section_id: S.s1 });
    expect(ts.get(T.t3)!.parent_task_id).toBe(T.t1); // subtarefa de subtarefa sob a principal
    expect(ts.get(T.t4)).toMatchObject({ owner_person_id: ana, project_id: null, due_date: "2026-10-04" }); // sem data: dia da criação em SP
    // Projeto ligado à missão; Bruno virou membro (responsável); o geral tem todos; o órfão não veio.
    const proj = (await owner.query("SELECT id, mission_id, color FROM task_projects WHERE id = ANY($1::uuid[]) ORDER BY name", [Object.values(P)])).rows;
    expect(proj).toEqual([
      { id: P.geral, mission_id: null, color: "#5b7cfa" },
      { id: P.obra, mission_id: missao, color: "#aabbcc" },
    ]);
    const membros = (await owner.query("SELECT project_id, person_id, role FROM task_project_members WHERE project_id = ANY($1::uuid[]) ORDER BY project_id, role", [[P.obra, P.geral]])).rows;
    expect(membros).toEqual(
      expect.arrayContaining([
        { project_id: P.obra, person_id: ana, role: "owner" },
        { project_id: P.obra, person_id: bruno, role: "member" },
        { project_id: P.geral, person_id: bruno, role: "member" },
      ]),
    );
    // Só o histórico do Foco (nenhum "criou" dos gatilhos) e nenhum aviso; gatilhos ligados de novo.
    expect((await owner.query("SELECT count(*)::int AS n FROM task_activity WHERE task_id = ANY($1::uuid[])", [Object.values(T)])).rows[0].n).toBe(1);
    expect((await owner.query("SELECT count(*)::int AS n FROM notifications WHERE task_id = ANY($1::uuid[])", [Object.values(T)])).rows[0].n).toBe(0);
    expect((await owner.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'tasks'::regclass AND NOT tgisinternal AND tgenabled <> 'O'")).rows[0].n).toBe(0);
    // Comentários, menção, reação (o 🔥 não existe no Omni) e a conversa do projeto.
    expect((await owner.query("SELECT id FROM task_comments WHERE task_id = $1", [T.t1])).rows.map((x) => x.id)).toEqual([C.c1]);
    expect((await owner.query("SELECT emoji FROM task_comment_reactions WHERE comment_id = $1", [C.c1])).rows).toEqual([{ emoji: "👍" }]);
    const conversa = uuidDe(`foco-conversa:${P.obra}`);
    expect((await owner.query("SELECT body FROM task_comments WHERE task_id = $1 ORDER BY created_at", [conversa])).rows.map((x) => x.body)).toEqual(["Bom dia, time", "Bom dia @Ana"]);
    // Chaves: a ativa e a do Prisma continuam valendo pelo mesmo token; revogada e codex não.
    const chave = async (t: string) => (await owner.query("SELECT person_id, scopes, client FROM app.resolver_chave_api($1)", [createHash("sha256").update(t).digest()])).rows[0];
    expect(await chave(TOKEN)).toMatchObject({ person_id: ana, scopes: ["read"], client: null });
    expect(await chave(TOKEN_PRISMA)).toMatchObject({ person_id: bruno, scopes: ["tasks:read:self"], client: "prisma" });
    expect((await owner.query("SELECT count(*)::int AS n FROM api_keys WHERE foco_id = ANY($1::uuid[])", [[K.revogada, K.codex]])).rows[0].n).toBe(0);
    // Agenda: o link assinado no Foco continua batendo (mesmo texto assinado).
    const [f] = (await owner.query("SELECT person_id, signed_subject, signed_created FROM app.agenda_por_link($1)", [FEED.id])).rows;
    const chaveAgenda = "chave-de-teste-com-32-caracteres!!";
    const doFoco = createHmac("sha256", chaveAgenda).update(`${FEED.id}:${U.ana}:${FEED.criado}`).digest("hex");
    expect(createHmac("sha256", chaveAgenda).update(`${FEED.id}:${f.signed_subject}:${f.signed_created}`).digest("hex")).toBe(doFoco);
    // Anexo no SharePoint com o SHA-256; preferência de e-mail; vínculo da pessoa.
    expect(enviados).toEqual([`Tarefas-teste/${T.t1}/${ANEXO.id}.jpg`]);
    expect((await owner.query("SELECT sha256 FROM task_attachments WHERE id = $1", [ANEXO.id])).rows[0].sha256).toBe(createHash("sha256").update(ANEXO.bytes).digest("hex"));
    expect((await owner.query("SELECT lembretes FROM email_preferences WHERE person_id = $1", [ana])).rows[0].lembretes).toBe(false);
    expect((await owner.query("SELECT foco_user_id FROM people WHERE id = $1", [ana])).rows[0].foco_user_id).toBe(U.ana);
    const texto = relatorioEmTexto(r);
    expect(texto).toContain(`${E.fora}: sem conta no Omni`);
    expect(texto).toContain("Automação Filtrovali (leitura)");
  });

  it("carga de novo: não duplica; o que sumiu do Foco sai do Omni; o criado no Omni fica", async () => {
    // No Omni, uma tarefa nova no projeto migrado (não vem do Foco).
    const nova = (await owner.query("INSERT INTO tasks (content, project_id, created_by) VALUES ('Criada no Omni', $1, $2) RETURNING id", [P.obra, ana])).rows[0].id;
    const dados = focoDeMentira();
    dados.tasks = dados.tasks!.filter((t) => t.id !== T.t7); // apagada no Foco
    const r = await importarFoco(owner, fonte(dados), { ...op, real: true });
    expect(r.removidas.tasks).toBe(1);
    expect(r.anexos.jaEstavam).toBe(1);
    expect(enviados).toHaveLength(1); // o anexo não sobe de novo
    expect((await tarefas()).map((t) => t.id).sort()).toEqual([T.t1, T.t2, T.t3, T.t4].sort());
    expect((await owner.query("SELECT count(*)::int AS n FROM tasks WHERE id = $1", [nova])).rows[0].n).toBe(1);
    expect((await owner.query("SELECT count(*)::int AS n FROM task_comments WHERE id = $1", [C.c1])).rows[0].n).toBe(1);
  });
});
