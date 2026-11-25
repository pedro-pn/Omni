import { createHash } from "node:crypto";

import { nextRecurrenceDate, parseRecurrenceInput } from "@omni/core";
import { schema, withPerson, type Db } from "@omni/db";
import { and, asc, desc, eq, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type pg from "pg";

/**
 * API /api/v1 de tarefas, compatível com a do Foco (mesmas rotas, campos e
 * erros — `foco/public/openapi.json`), para o Prisma e as automações seguirem
 * funcionando quando `foco.filtrovali.com.br` passar a apontar para o Omni.
 *
 * A chave (Bearer `foco_live_…`) é resolvida pelo hash e a requisição roda
 * com a identidade do dono (withPerson): quem vê e edita é decidido pelo RLS,
 * como na tela. Chave do Prisma (escopo tasks:read:self) só lê as próprias
 * tarefas. Diferença do Foco: concluir tarefa que repete avança a data, como
 * na tela (no Foco a API concluía de vez).
 */

const VERSAO = "1.0.0";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

type Resultado = { status: number; data: unknown };
type Chave = { personId: string; email: string; scopes: string[]; client: string | null };

export class ErroApi extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
  ) {
    super(codigo);
  }
}

const hoje = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
export const hashChave = (chave: string) => createHash("sha256").update(chave, "utf8").digest();

function resposta(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Foco-API-Version": VERSAO, ...CORS },
  });
}

export async function tratarApiV1(request: Request, pool: pg.Pool): Promise<Response> {
  const url = new URL(request.url);
  const caminho = url.pathname.replace(/^\/api\/v1/, "") || "/";
  const metodo = request.method.toUpperCase();

  if (metodo === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (caminho === "/health") return resposta({ status: "ok", service: "omni-tarefas", version: VERSAO });
  if (caminho === "/openapi.json") return Response.redirect(new URL("/openapi.json", request.url), 307);

  const bruta = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bruta) return resposta({ error: "missing_api_key" }, 401);
  if (Number(request.headers.get("content-length") || 0) > 1_048_576) return resposta({ error: "payload_too_large" }, 413);

  let corpo: Record<string, unknown> = {};
  if (!["GET", "HEAD", "DELETE"].includes(metodo)) {
    try {
      const texto = await request.text();
      if (texto.length > 1_048_576) return resposta({ error: "payload_too_large" }, 413);
      corpo = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
      if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) throw new Error();
    } catch {
      return resposta({ error: "invalid_json" }, 400);
    }
  }

  const { rows } = await pool.query<{ person_id: string; email: string; scopes: string[]; client: string | null }>(
    "SELECT person_id, email, scopes, client FROM app.resolver_chave_api($1)",
    [hashChave(bruta)],
  );
  const linha = rows[0];
  if (!linha) return resposta({ error: "invalid_api_key" }, 401);
  const chave: Chave = { personId: linha.person_id, email: String(linha.email).toLowerCase(), scopes: linha.scopes, client: linha.client };

  const query = Object.fromEntries(url.searchParams);
  const soPropria = chave.scopes.includes("tasks:read:self");
  if (soPropria) {
    if (metodo !== "GET" || !new RegExp(`^/tasks(/${UUID})?$`, "i").test(caminho)) return resposta({ error: "prisma_read_only" }, 403);
    query.assignee_email = chave.email;
  } else if (metodo === "GET" && !chave.scopes.some((s) => s === "read" || s === "write")) {
    return resposta({ error: "missing_read_scope" }, 403);
  } else if (metodo !== "GET" && !chave.scopes.includes("write")) {
    return resposta({ error: "missing_write_scope" }, 403);
  }

  try {
    const r = await withPerson(pool, chave.personId, (db) => rotear(db, chave, metodo, caminho, query, corpo));
    if (soPropria && caminho !== "/tasks" && r.status === 200 && (r.data as TarefaFoco).assignee_email !== chave.email) {
      return resposta({ error: "task_not_found" }, 404);
    }
    return resposta(r.data, r.status);
  } catch (error) {
    if (error instanceof ErroApi) return resposta({ error: error.codigo }, error.status);
    const codigo = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
    if (codigo === "42501") return resposta({ error: "forbidden" }, 403);
    if (codigo && /^(22|23)/.test(codigo)) return resposta({ error: "invalid_request" }, 422);
    console.error("[api/v1] erro:", (error as Error).message);
    return resposta({ error: "internal_error" }, 500);
  }
}

// ---------------------------------------------------------------- formato do Foco

const responsavel = alias(schema.people, "responsavel");
const dono = alias(schema.people, "dono");

type TarefaFoco = ReturnType<typeof tarefaFoco>;

function tarefaFoco(t: typeof schema.tasks.$inferSelect, emailResponsavel: string | null, emailDono: string | null) {
  return {
    id: t.id,
    content: t.content,
    description: t.description,
    due_date: t.dueDate,
    due_time: t.dueTime,
    priority: t.priority,
    project_id: t.projectId,
    section_id: t.sectionId,
    parent_task_id: t.parentTaskId,
    tag: t.labels[0] ?? null,
    labels: t.labels.length ? t.labels.join(",") : null,
    // Na caixa pessoal o responsável é o dono (como no Foco).
    assignee_email: (emailResponsavel ?? (t.ownerPersonId ? emailDono : null))?.toLowerCase() ?? null,
    owner_user_id: t.ownerPersonId,
    created_by: t.createdBy,
    completed: t.completed,
    completed_at: t.completedAt?.toISOString() ?? null,
    position: t.position,
    recurrence: t.recurrence,
    deadline: t.deadline,
    duration_minutes: t.durationMinutes,
    reminder_at: t.reminderAt?.toISOString() ?? null,
    reminder_offset_minutes: t.reminderOffsetMinutes,
    reminder_sent_at: t.reminderSentAt?.toISOString() ?? null,
    created_at: t.createdAt.toISOString(),
  };
}

function projetoFoco(p: typeof schema.taskProjects.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    description: p.description,
    mission_id: p.missionId,
    archived_at: p.archivedAt?.toISOString() ?? null,
    created_by: p.createdBy,
    created_at: p.createdAt.toISOString(),
  };
}

async function lerTarefas(db: Db, onde: SQL | undefined, limite = 200): Promise<TarefaFoco[]> {
  const linhas = await db
    .select({ t: schema.tasks, er: responsavel.email, ed: dono.email })
    .from(schema.tasks)
    .leftJoin(responsavel, eq(responsavel.id, schema.tasks.assigneePersonId))
    .leftJoin(dono, eq(dono.id, schema.tasks.ownerPersonId))
    .where(onde)
    .orderBy(asc(schema.tasks.position), asc(schema.tasks.createdAt))
    .limit(limite);
  return linhas.map((l) => tarefaFoco(l.t, l.er ? String(l.er) : null, l.ed ? String(l.ed) : null));
}

async function tarefa(db: Db, id: string): Promise<TarefaFoco> {
  const [t] = await lerTarefas(db, eq(schema.tasks.id, id), 1);
  if (!t) throw new ErroApi(404, "task_not_found");
  return t;
}

async function pessoaPorEmail(db: Db, email: unknown): Promise<string | null> {
  if (email === null || email === undefined || email === "") return null;
  if (typeof email !== "string") throw new ErroApi(422, "invalid_request");
  const [p] = await db
    .select({ id: schema.people.id })
    .from(schema.people)
    .where(and(sql`${schema.people.email} = ${email.trim().toLowerCase()}`, eq(schema.people.active, true)));
  if (!p) throw new ErroApi(422, "assignee_not_found");
  return p.id;
}

// ---------------------------------------------------------------- campos de entrada

const texto = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? null : String(v));
const data = (v: unknown) => {
  const s = texto(v);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ErroApi(422, "invalid_request");
  return s;
};
const hora = (v: unknown) => {
  const s = texto(v);
  if (!s) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s)) throw new ErroApi(422, "invalid_request");
  return s.length === 5 ? `${s}:00` : s;
};
const inteiro = (v: unknown, min: number, max: number) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ErroApi(422, "invalid_request");
  return n;
};
const etiquetas = (v: unknown): string[] => {
  const lista = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
  return lista.map((e) => e.trim()).filter(Boolean).slice(0, 10);
};
const recorrencia = (v: unknown) => {
  const s = texto(v)?.trim();
  if (!s) return null;
  const r = parseRecurrenceInput(s);
  if (!r.valid || !r.value) throw new ErroApi(422, "invalid_recurrence");
  return r.value;
};
const instante = (v: unknown) => {
  const s = texto(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ErroApi(422, "invalid_request");
  return d;
};

// ---------------------------------------------------------------- rotas

async function rotear(
  db: Db,
  chave: Chave,
  metodo: string,
  caminho: string,
  q: Record<string, string>,
  b: Record<string, unknown>,
): Promise<Resultado> {
  const id = (padrao: string) => caminho.match(new RegExp(`^${padrao.replace(":id", `(${UUID})`)}$`, "i"))?.[1]?.toLowerCase();
  const limite = Math.min(Math.max(Number.parseInt(q.limit ?? "100", 10) || 100, 1), 200);

  // Projetos
  if (caminho === "/projects" && metodo === "GET") {
    const ps = await db
      .select()
      .from(schema.taskProjects)
      .where(q.archived === "true" ? undefined : isNull(schema.taskProjects.archivedAt))
      .orderBy(asc(schema.taskProjects.createdAt));
    return { status: 200, data: { results: ps.map(projetoFoco) } };
  }
  if (caminho === "/projects" && metodo === "POST") {
    const nome = texto(b.name)?.trim();
    if (!nome) throw new ErroApi(422, "name_required");
    const r = await db.execute<{ id: string }>(
      sql`SELECT app.criar_projeto_tarefas(${nome}, ${texto(b.color)}, NULL) AS id`,
    );
    const novoId = r.rows[0]!.id;
    if (typeof b.description === "string") {
      await db.update(schema.taskProjects).set({ description: b.description }).where(eq(schema.taskProjects.id, novoId));
    }
    const [p] = await db.select().from(schema.taskProjects).where(eq(schema.taskProjects.id, novoId));
    return { status: 201, data: projetoFoco(p!) };
  }
  const projetoId = id("/projects/:id");
  if (projetoId) {
    const [p] = await db.select().from(schema.taskProjects).where(eq(schema.taskProjects.id, projetoId));
    if (!p) throw new ErroApi(404, "project_not_found");
    if (metodo === "GET") return { status: 200, data: projetoFoco(p) };
    const mudanca =
      metodo === "PATCH"
        ? {
            ...(typeof b.name === "string" ? { name: b.name.trim() } : {}),
            ...(typeof b.description === "string" ? { description: b.description } : {}),
            ...(typeof b.color === "string" ? { color: b.color } : {}),
          }
        : metodo === "DELETE"
          ? { archivedAt: new Date() }
          : null;
    if (!mudanca) throw new ErroApi(405, "method_not_allowed");
    if (!Object.keys(mudanca).length) return { status: 200, data: projetoFoco(p) };
    const [novo] = await db.update(schema.taskProjects).set(mudanca).where(eq(schema.taskProjects.id, projetoId)).returning();
    if (!novo) throw new ErroApi(403, "forbidden");
    return { status: 200, data: projetoFoco(novo) };
  }

  // Tarefas
  if (caminho === "/tasks" && metodo === "GET") {
    const filtros: Array<SQL | undefined> = [];
    if (q.project_id) filtros.push(eq(schema.tasks.projectId, q.project_id));
    if (q.completed === "true" || q.completed === "false") filtros.push(eq(schema.tasks.completed, q.completed === "true"));
    if (q.due_before) filtros.push(lte(schema.tasks.dueDate, data(q.due_before)!));
    if (q.due_after) filtros.push(gte(schema.tasks.dueDate, data(q.due_after)!));
    if (q.assignee_email) {
      const email = q.assignee_email.trim().toLowerCase();
      filtros.push(
        or(
          sql`${responsavel.email} = ${email}`,
          and(isNull(schema.tasks.assigneePersonId), sql`${dono.email} = ${email}`),
        ),
      );
    }
    return { status: 200, data: { results: await lerTarefas(db, and(...filtros), limite) } };
  }
  if (caminho === "/tasks" && metodo === "POST") {
    const conteudo = texto(b.content)?.trim();
    if (!conteudo) throw new ErroApi(422, "content_required");
    const projeto = texto(b.project_id) || null;
    if (projeto) {
      const [p] = await db.select({ id: schema.taskProjects.id }).from(schema.taskProjects).where(eq(schema.taskProjects.id, projeto));
      if (!p) throw new ErroApi(404, "project_not_found");
    }
    const responsavelId = projeto ? await pessoaPorEmail(db, b.assignee_email) : null;
    const [nova] = await db
      .insert(schema.tasks)
      .values({
        content: conteudo,
        description: texto(b.description) ?? "",
        projectId: projeto,
        ownerPersonId: projeto ? null : chave.personId,
        sectionId: projeto ? texto(b.section_id) || null : null,
        parentTaskId: texto(b.parent_task_id) || null,
        assigneePersonId: responsavelId,
        priority: inteiro(b.priority, 1, 4) ?? 4,
        dueDate: data(b.due_date) ?? hoje(),
        dueTime: hora(b.due_time),
        recurrence: recorrencia(b.recurrence),
        deadline: data(b.deadline),
        labels: etiquetas(b.labels),
        durationMinutes: inteiro(b.duration_minutes, 1, 100_000),
        reminderAt: instante(b.reminder_at),
        reminderOffsetMinutes: inteiro(b.reminder_offset_minutes, 0, 10_080),
        createdBy: chave.personId,
      })
      .returning({ id: schema.tasks.id });
    return { status: 201, data: await tarefa(db, nova!.id) };
  }
  const fecharId = id("/tasks/:id/close");
  const reabrirId = id("/tasks/:id/reopen");
  if ((fecharId || reabrirId) && metodo === "POST") {
    const tid = (fecharId ?? reabrirId)!;
    const atual = await tarefa(db, tid);
    await exigirEdicao(db, tid);
    if (fecharId && !atual.completed) {
      const proxima = atual.recurrence ? nextRecurrenceDate(atual.recurrence, atual.due_date, hoje()) : null;
      if (proxima) {
        await db.execute(sql`SELECT set_config('app.acao_tarefa', 'concluir', true)`);
        await db.update(schema.tasks).set({ dueDate: proxima }).where(eq(schema.tasks.id, tid));
      } else {
        await db
          .update(schema.tasks)
          .set({ completed: true, completedAt: new Date(), completedBy: chave.personId })
          .where(eq(schema.tasks.id, tid));
      }
    } else if (reabrirId && atual.completed) {
      await db.update(schema.tasks).set({ completed: false, completedAt: null, completedBy: null }).where(eq(schema.tasks.id, tid));
    }
    return { status: 200, data: await tarefa(db, tid) };
  }
  const tarefaId = id("/tasks/:id");
  if (tarefaId) {
    const atual = await tarefa(db, tarefaId);
    if (metodo === "GET") return { status: 200, data: atual };
    await exigirEdicao(db, tarefaId);
    if (metodo === "DELETE") {
      const r = await db.delete(schema.tasks).where(eq(schema.tasks.id, tarefaId)).returning({ id: schema.tasks.id });
      if (!r.length) throw new ErroApi(403, "forbidden");
      return { status: 200, data: atual };
    }
    if (metodo !== "PATCH") throw new ErroApi(405, "method_not_allowed");
    const m: Partial<typeof schema.tasks.$inferInsert> = {};
    if ("content" in b) {
      const c = texto(b.content)?.trim();
      if (!c) throw new ErroApi(422, "content_required");
      m.content = c;
    }
    if ("description" in b) m.description = texto(b.description) ?? "";
    if ("priority" in b) m.priority = inteiro(b.priority, 1, 4) ?? 4;
    if ("due_date" in b) m.dueDate = data(b.due_date) ?? atual.due_date;
    if ("due_time" in b) m.dueTime = hora(b.due_time);
    if ("recurrence" in b) m.recurrence = recorrencia(b.recurrence);
    if ("deadline" in b) m.deadline = data(b.deadline);
    if ("labels" in b) m.labels = etiquetas(b.labels);
    if ("duration_minutes" in b) m.durationMinutes = inteiro(b.duration_minutes, 1, 100_000);
    if ("reminder_at" in b) m.reminderAt = instante(b.reminder_at);
    if ("reminder_offset_minutes" in b) m.reminderOffsetMinutes = inteiro(b.reminder_offset_minutes, 0, 10_080);
    if ("assignee_email" in b) {
      if (!atual.project_id) throw new ErroApi(422, "inbox_task_has_no_assignee");
      m.assigneePersonId = await pessoaPorEmail(db, b.assignee_email);
    }
    if (Object.keys(m).length) await db.update(schema.tasks).set(m).where(eq(schema.tasks.id, tarefaId));
    return { status: 200, data: await tarefa(db, tarefaId) };
  }

  // Seções
  if (caminho === "/sections" && metodo === "GET") {
    const ss = await db
      .select()
      .from(schema.taskSections)
      .where(q.project_id ? eq(schema.taskSections.projectId, q.project_id) : undefined)
      .orderBy(asc(schema.taskSections.position));
    return {
      status: 200,
      data: { results: ss.map((s) => ({ id: s.id, project_id: s.projectId, name: s.name, position: s.position, created_at: s.createdAt.toISOString() })) },
    };
  }
  if (caminho === "/sections" && metodo === "POST") {
    const nome = texto(b.name)?.trim();
    const projeto = texto(b.project_id);
    if (!nome || !projeto) throw new ErroApi(422, "invalid_request");
    const [s] = await db
      .insert(schema.taskSections)
      .values({ projectId: projeto, name: nome, position: inteiro(b.position, 0, 1_000_000) ?? 0 })
      .returning();
    return { status: 201, data: { id: s!.id, project_id: s!.projectId, name: s!.name, position: s!.position, created_at: s!.createdAt.toISOString() } };
  }

  // Comentários
  const comentarioFoco = (c: typeof schema.taskComments.$inferSelect) => ({
    id: c.id,
    task_id: c.taskId,
    user_id: c.authorPersonId,
    content: c.body,
    created_at: c.createdAt.toISOString(),
    source_author: null,
    source_comment_id: null,
  });
  if (caminho === "/comments" && metodo === "GET") {
    const cs = await db
      .select()
      .from(schema.taskComments)
      .where(q.task_id ? eq(schema.taskComments.taskId, q.task_id) : undefined)
      .orderBy(asc(schema.taskComments.createdAt))
      .limit(limite);
    return { status: 200, data: { results: cs.map(comentarioFoco) } };
  }
  if (caminho === "/comments" && metodo === "POST") {
    const tid = texto(b.task_id);
    if (!tid) throw new ErroApi(404, "task_not_found");
    await tarefa(db, tid);
    const conteudo = texto(b.content)?.trim();
    if (!conteudo) throw new ErroApi(422, "content_required");
    const [c] = await db.insert(schema.taskComments).values({ taskId: tid, authorPersonId: chave.personId, body: conteudo }).returning();
    return { status: 201, data: comentarioFoco(c!) };
  }

  // Histórico
  if (caminho === "/activity" && metodo === "GET") {
    const as = await db
      .select({ a: schema.taskActivity, projeto: schema.tasks.projectId })
      .from(schema.taskActivity)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskActivity.taskId))
      .where(q.task_id ? eq(schema.taskActivity.taskId, q.task_id) : undefined)
      .orderBy(desc(schema.taskActivity.createdAt))
      .limit(limite);
    return {
      status: 200,
      data: {
        results: as.map(({ a, projeto }) => ({
          id: a.id,
          project_id: projeto,
          task_id: a.taskId,
          actor_user_id: a.actorPersonId,
          action: a.action,
          entity_type: "task",
          entity_id: a.taskId,
          summary: a.summary,
          metadata: a.metadata,
          created_at: a.createdAt.toISOString(),
        })),
      },
    };
  }

  throw new ErroApi(404, "not_found");
}

async function exigirEdicao(db: Db, id: string) {
  const r = await db.execute<{ pode: boolean }>(sql`SELECT app.pode_editar_tarefa(${id}) AS pode`);
  if (!r.rows[0]?.pode) throw new ErroApi(403, "forbidden");
}
