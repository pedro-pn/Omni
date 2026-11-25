import { createHmac, timingSafeEqual } from "node:crypto";

import { agendaIcs, type TarefaAgenda } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import { getPool } from "./db.ts";
import { getEnv } from "./env.ts";

/**
 * Agenda das tarefas por link privado (.ics), porta do `apple-calendar.ts` do
 * Foco: link `<id>.<HMAC-SHA256 hex de "id:assunto:criado">` com
 * APPLE_CALENDAR_SIGNING_KEY. O conteúdo é montado como a própria pessoa (RLS):
 * tarefas abertas dela (dona ou responsável), fora de projetos arquivados.
 */

export const agendaConfigurada = () => Boolean(getEnv().APPLE_CALENDAR_SIGNING_KEY);

export function assinarAgenda(f: { id: string; signedSubject: string; signedCreated: string }): string {
  const chave = getEnv().APPLE_CALENDAR_SIGNING_KEY;
  if (!chave) throw new Error("agenda sem chave");
  return createHmac("sha256", chave).update(`${f.id}:${f.signedSubject}:${f.signedCreated}`).digest("hex");
}

export function enderecosDaAgenda(f: { id: string; signedSubject: string; signedCreated: string }) {
  const https = `${getEnv().APP_ORIGIN.replace(/\/$/, "")}/api/calendar/apple/feed/${f.id}.${assinarAgenda(f)}.ics`;
  return { https, webcal: https.replace(/^https?:/, "webcal:") };
}

/** Confere o link; devolve a pessoa dona (ou null: link inválido, revogado ou pessoa desativada). */
export async function pessoaDoLink(token: string): Promise<{ feedId: string; personId: string } | null> {
  const m = token.match(/^([0-9a-f-]{36})\.([0-9a-f]{64})$/i);
  if (!m || !agendaConfigurada()) return null;
  const [, id, assinatura] = m as unknown as [string, string, string];
  const { rows } = await getPool().query<{ person_id: string; signed_subject: string; signed_created: string }>("SELECT * FROM app.agenda_por_link($1)", [id]);
  const f = rows[0];
  if (!f) return null;
  const esperada = Buffer.from(assinarAgenda({ id, signedSubject: f.signed_subject, signedCreated: f.signed_created }));
  const recebida = Buffer.from(assinatura.toLowerCase());
  if (esperada.length !== recebida.length || !timingSafeEqual(esperada, recebida)) return null;
  return { feedId: id, personId: f.person_id };
}

export async function montarAgenda(personId: string): Promise<string> {
  const t = schema.tasks;
  const p = schema.taskProjects;
  const linhas = await withPerson(getPool(), personId, (db) =>
    db
      .select({ t, projeto: p.name })
      .from(t)
      .leftJoin(p, eq(p.id, t.projectId))
      .where(and(eq(t.completed, false), or(eq(t.ownerPersonId, personId), eq(t.assigneePersonId, personId)), or(isNull(t.projectId), isNull(p.archivedAt))))
      .orderBy(t.dueDate, sql`${t.dueTime} NULLS FIRST`)
      .limit(2000),
  );
  const tarefas: TarefaAgenda[] = linhas.map(({ t: x, projeto }) => ({
    id: x.id,
    titulo: x.content,
    descricao: x.description,
    data: x.dueDate,
    hora: x.dueTime,
    duracaoMinutos: x.durationMinutes,
    lembreteMinutos: x.reminderOffsetMinutes,
    lembreteEm: x.reminderAt?.toISOString() ?? null,
    recorrencia: x.recurrence,
    projeto: projeto ?? null,
    criadaEm: x.createdAt.toISOString(),
  }));
  return agendaIcs(tarefas, getEnv().APP_ORIGIN.replace(/\/$/, ""));
}
