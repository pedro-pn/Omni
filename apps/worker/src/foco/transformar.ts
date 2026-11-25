import { createHash } from "node:crypto";

import type { Linha, UsuarioFoco } from "./fonte.ts";

/**
 * Do Foco para o Omni (Fase 3, PLANEJAMENTO §3.3), sem acesso a nada: recebe as linhas
 * lidas do Foco, as pessoas e missões do Omni e devolve o que gravar (no formato das
 * tabelas do Omni, com o MESMO id do Foco e `foco_id`) e o relatório.
 *
 * Regras:
 * - Pessoa do Foco ↔ pessoa do Omni pelo e-mail (sem diferença de maiúsculas). Quem não
 *   casou entra no relatório; o que é só dela (caixa pessoal, comentário, filtro, chave)
 *   não migra, e a autoria de projetos e tarefas cai em quem é dono do lugar.
 * - O Omni tem um nível de subtarefa, no mesmo lugar da principal: subtarefa de
 *   subtarefa fica sob a principal do topo.
 * - Projeto com um número de missão no nome (4 dígitos, um só) liga à missão, se ela
 *   ainda não tiver projeto.
 * - Responsável de tarefa de projeto vira membro do projeto (no Omni, o responsável
 *   precisa ser membro); na caixa pessoal, só o próprio dono.
 * - Chaves de API: só as ativas, pelo mesmo hash; a do Prisma (concessão) vira a chave
 *   do Prisma no Omni (só as tarefas da própria pessoa).
 * - Feeds de agenda: mesmo id, assinados com o `user_id` e o `created_at` do Foco como texto.
 */

export const TABELAS_MIGRADAS = [
  "members",
  "workspace_members",
  "projects",
  "project_members",
  "pending_project_members",
  "sections",
  "tasks",
  "comments",
  "comment_mentions",
  "comment_reactions",
  "activity_log",
  "attachments",
  "saved_filters",
  "api_keys",
  "prisma_authorization_grants",
  "apple_calendar_feeds",
  "user_notification_settings",
  "project_messages",
  "project_message_mentions",
] as const;
/** Lidas só para contar no relatório (não têm destino no Omni). */
export const TABELAS_SEM_DESTINO = [
  "workspaces",
  "folders",
  "project_preferences",
  "project_notification_preferences",
  "notifications",
  "invitations",
  "access_requests",
  "project_departures",
  "google_calendar_connections",
  "google_calendar_events",
] as const;

export type DadosFoco = { usuarios: UsuarioFoco[] } & Record<(typeof TABELAS_MIGRADAS)[number], Linha[]> & Partial<Record<(typeof TABELAS_SEM_DESTINO)[number], Linha[] | null>>;
export type PessoaOmni = { id: string; email: string; active: boolean };
export type MissaoOmni = { id: string; code: string; projetoId: string | null };
export type OpcoesTransformar = {
  /** Nomes de chaves de API que não migram (ex.: uma chave antiga a revogar). */
  pularChaves?: string[];
  /** Projetos (pelo nome) cuja conversa vira os comentários de uma tarefa "Conversa do projeto". */
  conversas?: string[];
  agora?: Date;
};

type R = Record<string, unknown>;
export type AnexoParaCopiar = { focoId: string; taskId: string; nome: string; tipo: string; tamanho: number; chave: string; autor: string | null; em: string };
export type ChaveNoRelatorio = { nome: string; email: string | null; tipo: "prisma" | "leitura" | "escrita"; ultimoUso: string | null };
export type PessoaNoRelatorio = { focoId: string; email: string | null; situacao: "casou" | "inativa no Omni" | "sem conta no Omni"; tarefas: number };

export type Carga = {
  projetos: R[];
  membros: R[];
  secoes: R[];
  tarefas: R[];
  comentarios: R[];
  mencoes: R[];
  reacoes: R[];
  historico: R[];
  filtros: R[];
  chaves: R[];
  agendas: R[];
  preferencias: R[];
  vinculosFoco: { person_id: string; foco_user_id: string }[];
  anexos: AnexoParaCopiar[];
};
export type Relatorio = {
  lidas: Record<string, number>;
  pessoas: PessoaNoRelatorio[];
  responsaveisSemConta: { email: string; tarefas: number }[];
  chaves: ChaveNoRelatorio[];
  avisos: Record<string, { quantidade: number; exemplos: string[] }>;
};

const s = (v: unknown): string | null => (typeof v === "string" ? v : v == null ? null : String(v));
const n = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const b = (v: unknown) => v === true || v === "true";
const email = (v: unknown) => s(v)?.trim().toLowerCase() || null;
const INT_MAX = 2_147_483_647;
const posicao = (v: unknown) => Math.max(-INT_MAX, Math.min(INT_MAX, Math.round(n(v) ?? 0)));
const COR_PADRAO = "#1e6b4a";
function cor(v: unknown): string {
  const c = s(v)?.trim() ?? "";
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  const m = c.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : COR_PADRAO;
}
/** Data (AAAA-MM-DD) do instante no fuso da empresa. */
export const dataSP = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
/** UUID fixo a partir de um texto (mesma entrada, mesmo id: a carga pode ser refeita). */
export function uuidDe(texto: string): string {
  const h = createHash("sha1").update(texto).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function etiquetas(labels: unknown, tag: unknown): string[] {
  let lista: unknown[] = [];
  if (Array.isArray(labels)) lista = labels;
  else if (typeof labels === "string" && labels.trim()) {
    try {
      const v = JSON.parse(labels) as unknown;
      lista = Array.isArray(v) ? v : [];
    } catch {
      lista = labels.split(",");
    }
  }
  const t = s(tag)?.trim();
  const todas = [...(t ? [t] : []), ...lista.map((x) => s(x)?.trim() ?? "")].filter(Boolean).map((x) => x.replace(/^@/, "").slice(0, 60));
  const vistas = new Set<string>();
  return todas.filter((x) => (vistas.has(x.toLowerCase()) ? false : (vistas.add(x.toLowerCase()), true)));
}
const EMOJIS = new Set(["👍", "❤️", "😂", "🎉", "😮", "😢"]);

export function transformar(d: DadosFoco, pessoasOmni: PessoaOmni[], missoes: MissaoOmni[], opcoes: OpcoesTransformar = {}): { carga: Carga; relatorio: Relatorio } {
  const agora = opcoes.agora ?? new Date();
  const avisos: Relatorio["avisos"] = {};
  const avisar = (tipo: string, exemplo: string) => {
    const a = (avisos[tipo] ??= { quantidade: 0, exemplos: [] });
    a.quantidade += 1;
    if (a.exemplos.length < 5) a.exemplos.push(exemplo);
  };

  // ------------------------------------------------------------------ pessoas
  const porEmail = new Map(pessoasOmni.map((p) => [p.email.toLowerCase(), p]));
  const emailDoUsuario = new Map<string, string>();
  for (const m of [...d.workspace_members, ...d.members]) {
    const id = s(m.user_id);
    const e = email(m.email);
    if (id && e && !emailDoUsuario.has(id)) emailDoUsuario.set(id, e);
  }
  for (const u of d.usuarios) if (u.email) emailDoUsuario.set(u.id, u.email.trim().toLowerCase()); // o login vale mais
  const pessoa = (userId: unknown): string | null => {
    const e = emailDoUsuario.get(s(userId) ?? "");
    return (e && porEmail.get(e)?.id) || null;
  };
  const pessoaPorEmail = (e: unknown): string | null => {
    const x = email(e);
    return (x && porEmail.get(x)?.id) || null;
  };

  // ------------------------------------------------------------------ projetos
  const membrosFoco = new Map<string, Linha[]>();
  for (const m of d.project_members) membrosFoco.set(s(m.project_id)!, [...(membrosFoco.get(s(m.project_id)!) ?? []), m]);
  const missaoPorCodigo = new Map(missoes.map((m) => [m.code, m]));
  const projetos: R[] = [];
  const criadorDoProjeto = new Map<string, string>();
  const missoesUsadas = new Set<string>();
  for (const p of d.projects) {
    const id = s(p.id)!;
    const donoMembro = (membrosFoco.get(id) ?? []).filter((m) => s(m.role) === "owner").map((m) => pessoa(m.user_id)).find(Boolean);
    const criador = pessoa(p.created_by) ?? donoMembro ?? null;
    if (!criador) {
      avisar("Projeto não migrado: nem quem criou nem um dono têm conta no Omni", id);
      continue;
    }
    const nome = (s(p.name)?.trim() || "Projeto").slice(0, 120);
    const codigos = [...new Set(nome.match(/(?<!\d)\d{4}(?!\d)/g) ?? [])];
    const missao = codigos.length === 1 ? missaoPorCodigo.get(codigos[0]!) : undefined;
    let missionId: string | null = null;
    if (missao && (missao.projetoId === null || missao.projetoId === id) && !missoesUsadas.has(missao.id)) {
      missionId = missao.id;
      missoesUsadas.add(missao.id);
    } else if (missao) avisar("Projeto com número de missão não ligado: a missão já tem projeto no Omni", id);
    if (s(p.folder_id)) avisar("Projeto que estava numa pasta do Foco (o Omni não tem pastas de projeto)", id);
    if (s(p.parent_project_id)) avisar("Subprojeto do Foco migrado como projeto comum", id);
    criadorDoProjeto.set(id, criador);
    projetos.push({
      id,
      name: nome,
      color: cor(p.color),
      description: s(p.description) ?? "",
      mission_id: missionId,
      archived_at: s(p.archived_at),
      created_by: criador,
      created_at: s(p.created_at),
      updated_at: s(p.created_at),
      foco_id: id,
    });
  }
  const projetoMigrado = new Set(projetos.map((p) => p.id as string));

  // ------------------------------------------------------------------ membros
  const membros = new Map<string, R>();
  const ROLES = new Set(["owner", "manager", "member"]);
  const incluir = (projeto: string, person: string, role: string, addedBy: string | null, addedAt: string | null) => {
    const k = `${projeto}|${person}`;
    const atual = membros.get(k);
    if (atual && (atual.role === "owner" || role === "member")) return;
    membros.set(k, { project_id: projeto, person_id: person, role, added_by: addedBy, added_at: addedAt ?? agora.toISOString() });
  };
  for (const m of d.project_members) {
    const projeto = s(m.project_id)!;
    if (!projetoMigrado.has(projeto)) continue;
    const p = pessoa(m.user_id);
    if (!p) {
      avisar("Membro de projeto sem conta no Omni", `${projeto}:${s(m.user_id)}`);
      continue;
    }
    incluir(projeto, p, ROLES.has(s(m.role) ?? "") ? s(m.role)! : "member", pessoa(m.added_by), s(m.added_at));
  }
  for (const m of d.pending_project_members) {
    const projeto = s(m.project_id)!;
    if (!projetoMigrado.has(projeto)) continue;
    const p = pessoaPorEmail(m.email);
    if (p) incluir(projeto, p, "member", pessoa(m.added_by), s(m.added_at));
    else avisar("Convite pendente de projeto para quem não tem conta no Omni", projeto);
  }
  for (const p of d.projects) {
    const id = s(p.id)!;
    if (!projetoMigrado.has(id)) continue;
    // O grupo geral do Foco é de todo o espaço de trabalho: todos entram como membros.
    if (b(p.is_general)) for (const w of d.workspace_members) {
      const x = pessoa(w.user_id);
      if (x) incluir(id, x, "member", null, s(w.joined_at));
    }
    incluir(id, criadorDoProjeto.get(id)!, "owner", null, s(p.created_at));
  }

  // ------------------------------------------------------------------ seções
  const secoes: R[] = [];
  const projetoDaSecao = new Map<string, string>();
  for (const x of d.sections) {
    const projeto = s(x.project_id)!;
    if (!projetoMigrado.has(projeto)) continue;
    projetoDaSecao.set(s(x.id)!, projeto);
    secoes.push({ id: s(x.id), project_id: projeto, name: (s(x.name)?.trim() || "Seção").slice(0, 120), position: posicao(x.position), created_at: s(x.created_at), foco_id: s(x.id) });
  }

  // ------------------------------------------------------------------ tarefas
  type Lugar = { projeto: string | null; dono: string | null };
  const brutas = new Map(d.tasks.map((t) => [s(t.id)!, t]));
  const lugarProprio = new Map<string, Lugar>();
  for (const t of d.tasks) {
    const id = s(t.id)!;
    const projeto = s(t.project_id);
    if (projeto) {
      if (projetoMigrado.has(projeto)) lugarProprio.set(id, { projeto, dono: null });
      else avisar("Tarefa de projeto não migrado", id);
      continue;
    }
    const dono = pessoa(t.owner_user_id);
    if (dono) lugarProprio.set(id, { projeto: null, dono });
    else avisar("Tarefa da caixa pessoal de quem não tem conta no Omni", id);
  }
  // Principal do topo (um nível de subtarefa no Omni).
  const topo = (id: string): string | null => {
    let atual = id;
    const vistos = new Set<string>();
    for (;;) {
      const pai = s(brutas.get(atual)?.parent_task_id);
      if (!pai || vistos.has(pai) || !brutas.has(pai)) return atual === id ? null : atual;
      vistos.add(atual);
      atual = pai;
    }
  };
  const tarefas: R[] = [];
  const contagemPorPessoa = new Map<string, number>();
  const semConta = new Map<string, number>();
  const ordenadas = [...d.tasks].sort((a, c) => Number(Boolean(s(a.parent_task_id))) - Number(Boolean(s(c.parent_task_id))));
  for (const t of ordenadas) {
    const id = s(t.id)!;
    let lugar = lugarProprio.get(id);
    if (!lugar) continue;
    let pai: string | null = null;
    if (s(t.parent_task_id)) {
      const principal = topo(id);
      if (principal && lugarProprio.has(principal)) {
        pai = principal;
        if (principal !== s(t.parent_task_id)) avisar("Subtarefa de subtarefa: ficou sob a tarefa principal", id);
        const doPai = lugarProprio.get(principal)!;
        if (doPai.projeto !== lugar.projeto || doPai.dono !== lugar.dono) {
          avisar("Subtarefa levada para o mesmo lugar da principal", id);
          lugar = doPai;
        }
      } else avisar("Subtarefa cuja principal não migrou: ficou como tarefa comum", id);
    }
    const secao = s(t.section_id);
    const secaoOk = secao && lugar.projeto && projetoDaSecao.get(secao) === lugar.projeto ? secao : null;
    let responsavel: string | null = null;
    const emailResp = email(t.assignee_email);
    if (emailResp) {
      responsavel = pessoaPorEmail(emailResp);
      if (!responsavel) semConta.set(emailResp, (semConta.get(emailResp) ?? 0) + 1);
      else if (lugar.projeto && !membros.has(`${lugar.projeto}|${responsavel}`)) {
        incluir(lugar.projeto, responsavel, "member", null, s(t.created_at));
        avisar("Responsável incluído como membro do projeto", id);
      } else if (!lugar.projeto && responsavel !== lugar.dono) {
        avisar("Responsável tirado de tarefa da caixa pessoal de outra pessoa", id);
        responsavel = null;
      }
    }
    const criadaEm = s(t.created_at) ?? agora.toISOString();
    let prazo = s(t.due_date);
    if (!prazo) {
      prazo = dataSP(criadaEm);
      avisar("Tarefa sem data: ficou com a data em que foi criada", id);
    }
    const autor = pessoa(t.created_by) ?? lugar.dono ?? criadorDoProjeto.get(lugar.projeto!)!;
    const duracao = n(t.duration_minutes);
    const lembrete = n(t.reminder_offset_minutes);
    const prioridade = n(t.priority);
    for (const x of new Set([lugar.dono, responsavel].filter((v): v is string => Boolean(v)))) contagemPorPessoa.set(x, (contagemPorPessoa.get(x) ?? 0) + 1);
    tarefas.push({
      id,
      content: (s(t.content)?.trim() || "(sem título)").slice(0, 500),
      description: s(t.description) ?? "",
      project_id: lugar.projeto,
      owner_person_id: lugar.projeto ? null : lugar.dono,
      section_id: secaoOk,
      parent_task_id: pai,
      assignee_person_id: responsavel,
      due_date: prazo,
      due_time: s(t.due_time),
      deadline: s(t.deadline),
      duration_minutes: duracao && duracao > 0 ? Math.round(duracao) : null,
      priority: prioridade && prioridade >= 1 && prioridade <= 4 ? Math.round(prioridade) : 4,
      labels: etiquetas(t.labels, t.tag),
      recurrence: s(t.recurrence)?.trim() || null,
      reminder_offset_minutes: lembrete !== null && lembrete >= 0 ? Math.round(lembrete) : null,
      reminder_at: s(t.reminder_at),
      reminder_sent_at: s(t.reminder_sent_at),
      position: posicao(t.position),
      completed: b(t.completed),
      completed_at: b(t.completed) ? (s(t.completed_at) ?? criadaEm) : null,
      completed_by: null,
      created_by: autor,
      created_at: criadaEm,
      updated_at: s(t.completed_at) && s(t.completed_at)! > criadaEm ? s(t.completed_at) : criadaEm,
      foco_id: id,
    });
  }
  const tarefaMigrada = new Set(tarefas.map((t) => t.id as string));

  // ------------------------------------------------------------------ comentários
  const comentarios: R[] = [];
  for (const c of d.comments) {
    if (!tarefaMigrada.has(s(c.task_id)!)) continue;
    const autor = pessoa(c.user_id);
    const corpo = s(c.content)?.trim() ?? "";
    if (!autor) avisar("Comentário de quem não tem conta no Omni", s(c.id)!);
    else if (!corpo) avisar("Comentário vazio", s(c.id)!);
    else comentarios.push({ id: s(c.id), task_id: s(c.task_id), author_person_id: autor, body: corpo.slice(0, 5000), created_at: s(c.created_at), edited_at: null, foco_id: s(c.id) });
  }

  // ------------------------------------------------------------------ conversas de projeto (opcional)
  const conversasDe = new Set((opcoes.conversas ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));
  if (conversasDe.size) {
    for (const p of projetos) {
      if (!conversasDe.has(String(p.name).toLowerCase())) continue;
      conversasDe.delete(String(p.name).toLowerCase());
      const msgs = d.project_messages.filter((m) => s(m.project_id) === p.id).sort((a, c) => String(a.created_at).localeCompare(String(c.created_at)));
      if (!msgs.length) continue;
      const tarefaId = uuidDe(`foco-conversa:${String(p.id)}`);
      tarefas.push({
        id: tarefaId,
        content: "Conversa do projeto (Foco)",
        description: "Mensagens da conversa deste projeto no Foco, até a mudança para o Omni. Continue a conversa nos comentários.",
        project_id: p.id,
        owner_person_id: null,
        section_id: null,
        parent_task_id: null,
        assignee_person_id: null,
        due_date: dataSP(String(msgs.at(-1)!.created_at)),
        due_time: null,
        deadline: null,
        duration_minutes: null,
        priority: 4,
        labels: [],
        recurrence: null,
        reminder_offset_minutes: null,
        reminder_at: null,
        reminder_sent_at: null,
        position: -1,
        completed: false,
        completed_at: null,
        completed_by: null,
        created_by: p.created_by,
        created_at: s(msgs[0]!.created_at),
        updated_at: s(msgs.at(-1)!.created_at),
        foco_id: null,
      });
      tarefaMigrada.add(tarefaId);
      for (const m of msgs) {
        const autor = pessoa(m.user_id);
        const corpo = s(m.content)?.trim() ?? "";
        if (!autor || !corpo) {
          avisar("Mensagem da conversa de projeto não migrada (autor sem conta no Omni ou vazia)", s(m.id)!);
          continue;
        }
        comentarios.push({ id: s(m.id), task_id: tarefaId, author_person_id: autor, body: corpo.slice(0, 5000), created_at: s(m.created_at), edited_at: null, foco_id: s(m.id) });
      }
    }
    for (const faltou of conversasDe) avisar("Conversa pedida de um projeto que não foi encontrado", faltou);
  }
  const comentarioMigrado = new Set(comentarios.map((c) => c.id as string));

  const mencoes = new Map<string, R>();
  for (const m of [...d.comment_mentions, ...d.project_message_mentions]) {
    const c = s(m.comment_id ?? m.message_id)!;
    const p = pessoa(m.user_id);
    if (comentarioMigrado.has(c) && p) mencoes.set(`${c}|${p}`, { comment_id: c, person_id: p });
  }
  const reacoes = new Map<string, R>();
  for (const r of d.comment_reactions) {
    const c = s(r.comment_id)!;
    const p = pessoa(r.user_id);
    const e = s(r.emoji) ?? "";
    if (!comentarioMigrado.has(c) || !p) continue;
    if (!EMOJIS.has(e)) {
      avisar("Reação com emoji que o Omni não tem", c);
      continue;
    }
    reacoes.set(`${c}|${p}|${e}`, { comment_id: c, person_id: p, emoji: e, created_at: s(r.created_at) });
  }

  // ------------------------------------------------------------------ histórico
  const historico: R[] = [];
  for (const a of d.activity_log) {
    const tarefa = s(a.task_id);
    if (!tarefa || !tarefaMigrada.has(tarefa)) continue;
    const acao = (s(a.action) ?? "foco").slice(0, 60);
    const meta = a.metadata && typeof a.metadata === "object" && !Array.isArray(a.metadata) ? a.metadata : {};
    historico.push({ id: s(a.id), task_id: tarefa, actor_person_id: pessoa(a.actor_user_id), action: acao, summary: (s(a.summary)?.trim() || acao).slice(0, 2000), metadata: meta, created_at: s(a.created_at), foco_id: s(a.id) });
  }

  // ------------------------------------------------------------------ anexos (cópia à parte)
  const anexos: AnexoParaCopiar[] = [];
  for (const x of d.attachments) {
    if (!tarefaMigrada.has(s(x.task_id)!)) {
      avisar("Anexo de tarefa não migrada", s(x.id)!);
      continue;
    }
    anexos.push({
      focoId: s(x.id)!,
      taskId: s(x.task_id)!,
      nome: (s(x.filename)?.trim() || "arquivo").slice(0, 255),
      tipo: (s(x.content_type) || "application/octet-stream").slice(0, 150),
      tamanho: n(x.size) ?? 0,
      chave: s(x.object_key)!,
      autor: pessoa(x.uploaded_by),
      em: s(x.created_at) ?? agora.toISOString(),
    });
  }

  // ------------------------------------------------------------------ filtros salvos
  const filtros: R[] = [];
  for (const f of d.saved_filters) {
    const p = pessoa(f.user_id);
    const consulta = s(f.query)?.trim() ?? "";
    if (!p || !consulta) {
      avisar("Filtro salvo não migrado (dono sem conta no Omni ou filtro vazio)", s(f.id)!);
      continue;
    }
    filtros.push({ id: s(f.id), person_id: p, name: (s(f.name)?.trim() || "Filtro").slice(0, 80), query: consulta.slice(0, 500), color: cor(f.color), favorite: b(f.favorite), created_at: s(f.created_at), foco_id: s(f.id) });
  }

  // ------------------------------------------------------------------ chaves de API
  const doPrisma = new Set(d.prisma_authorization_grants.map((g) => s(g.key_id)));
  const pular = new Set((opcoes.pularChaves ?? []).map((x) => x.trim().toLowerCase()));
  const chaves: R[] = [];
  const chavesNoRelatorio: ChaveNoRelatorio[] = [];
  for (const k of d.api_keys) {
    const id = s(k.id)!;
    const nome = s(k.name)?.trim() ?? "";
    if (s(k.revoked_at)) continue; // revogadas não migram
    if (s(k.expires_at) && new Date(s(k.expires_at)!) <= agora) {
      avisar("Chave de API vencida: não migrada", nome || id);
      continue;
    }
    if (pular.has(nome.toLowerCase())) {
      avisar("Chave de API deixada de fora (pedido na carga)", nome);
      continue;
    }
    const dono = pessoa(k.created_by);
    const hash = s(k.key_hash)?.toLowerCase() ?? "";
    if (!dono) {
      avisar("Chave de API de quem não tem conta no Omni", nome || id);
      continue;
    }
    if (!/^\\x[0-9a-f]{64}$/.test(hash)) {
      avisar("Chave de API com hash fora do formato (SHA-256)", nome || id);
      continue;
    }
    const prisma = doPrisma.has(id);
    const escopos = prisma ? ["tasks:read:self"] : (Array.isArray(k.scopes) ? k.scopes.map(String) : []).filter((x) => x === "read" || x === "write");
    chaves.push({
      id,
      person_id: dono,
      name: (nome.length >= 2 ? nome : "Chave do Foco").slice(0, 80),
      key_prefix: s(k.key_prefix) ?? "foco_live_",
      key_hash: hash,
      scopes: escopos.length ? escopos : ["read"],
      client: prisma ? "prisma" : null,
      last_used_at: s(k.last_used_at),
      expires_at: s(k.expires_at),
      revoked_at: null,
      created_at: s(k.created_at),
      foco_id: id,
    });
    chavesNoRelatorio.push({ nome, email: emailDoUsuario.get(s(k.created_by) ?? "") ?? null, tipo: prisma ? "prisma" : escopos.includes("write") ? "escrita" : "leitura", ultimoUso: s(k.last_used_at) });
  }

  // ------------------------------------------------------------------ agenda (.ics) e preferências
  const agendas: R[] = [];
  for (const f of d.apple_calendar_feeds) {
    const p = pessoa(f.user_id);
    if (!p) {
      avisar("Link de agenda de quem não tem conta no Omni", s(f.id)!);
      continue;
    }
    agendas.push({ id: s(f.id), person_id: p, signed_subject: s(f.user_id), signed_created: s(f.created_at), created_at: s(f.created_at), last_accessed_at: s(f.last_accessed_at) });
  }
  const preferencias: R[] = [];
  for (const u of d.user_notification_settings) {
    const p = pessoa(u.user_id);
    if (!p) continue;
    preferencias.push({
      person_id: p,
      lembretes: u.email_due_reminders !== false,
      atribuicoes: u.email_task_assigned !== false,
      mencoes: u.email_mentions !== false,
      concluidas: u.email_task_completed !== false,
    });
  }

  // ------------------------------------------------------------------ relatório das pessoas
  const usuariosFoco = new Map<string, string | null>();
  for (const u of d.usuarios) usuariosFoco.set(u.id, emailDoUsuario.get(u.id) ?? null);
  for (const w of d.workspace_members) if (s(w.user_id) && !usuariosFoco.has(s(w.user_id)!)) usuariosFoco.set(s(w.user_id)!, emailDoUsuario.get(s(w.user_id)!) ?? null);
  const pessoas: PessoaNoRelatorio[] = [...usuariosFoco].map(([focoId, e]) => {
    const p = e ? porEmail.get(e) : undefined;
    return { focoId, email: e, situacao: !p ? "sem conta no Omni" : p.active ? "casou" : "inativa no Omni", tarefas: p ? (contagemPorPessoa.get(p.id) ?? 0) : 0 };
  });
  const vinculosFoco = pessoas.flatMap((x) => (x.email && porEmail.get(x.email) ? [{ person_id: porEmail.get(x.email)!.id, foco_user_id: x.focoId }] : []));

  const lidas: Record<string, number> = { usuarios: d.usuarios.length };
  for (const t of [...TABELAS_MIGRADAS, ...TABELAS_SEM_DESTINO]) {
    const v = (d as Record<string, Linha[] | null | undefined>)[t];
    if (Array.isArray(v)) lidas[t] = v.length;
  }

  return {
    carga: {
      projetos,
      membros: [...membros.values()],
      secoes,
      tarefas,
      comentarios,
      mencoes: [...mencoes.values()],
      reacoes: [...reacoes.values()],
      historico,
      filtros,
      chaves,
      agendas,
      preferencias,
      vinculosFoco,
      anexos,
    },
    relatorio: {
      lidas,
      pessoas: pessoas.sort((a, c) => (a.email ?? "").localeCompare(c.email ?? "")),
      responsaveisSemConta: [...semConta].map(([e, q]) => ({ email: e, tarefas: q })).sort((a, c) => c.tarefas - a.tarefas),
      chaves: chavesNoRelatorio,
      avisos,
    },
  };
}
