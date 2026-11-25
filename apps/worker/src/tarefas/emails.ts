import { addDays, emailDeAvisos, emailSemanalAtrasadas, emailSemanalDaSemana, preferenciaDoAviso, type EmailMontado, type TarefaEmail } from "@omni/core";
import { schema, type Db } from "@omni/db";
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

/**
 * Avisos das tarefas por e-mail e resumo semanal (porta dos e-mails do Foco):
 *
 * * `avisos-email` (2 min): os avisos de tarefa de cada pessoa, ainda não lidos,
 *   num e-mail só, conforme as preferências dela (email_preferences). Aviso já
 *   lido no Omni, de tipo sem e-mail ou com a preferência desligada fica fora.
 *   Um aviso nunca entra em dois e-mails; com mais de 20 h, não sai mais.
 * * `resumo-semanal`: segunda 09h (atrasadas) e 14h (atividades da semana),
 *   uma vez por pessoa e semana (dedupe_key).
 *
 * Modo: "ensaio" monta e registra em notification_emails, sem enviar (fora da
 * produção é sempre assim); "real" envia pela caixa EMAIL_AVISOS_REMETENTE.
 */

export type EnviarEmail = (para: string, e: EmailMontado) => Promise<void>;
export type OpcoesEmail = { modo: "ensaio" | "real"; app: string; enviar: EnviarEmail | null };

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Prefs = { lembretes: boolean; atribuicoes: boolean; mencoes: boolean; comentarios: boolean; concluidas: boolean; resumoSemanal: boolean };
const PADRAO: Prefs = { lembretes: true, atribuicoes: true, mencoes: true, comentarios: true, concluidas: false, resumoSemanal: true };

async function preferencias(db: Db, pessoas: string[]): Promise<Map<string, Prefs>> {
  if (!pessoas.length) return new Map();
  const linhas = await db.select().from(schema.emailPreferences).where(inArray(schema.emailPreferences.personId, pessoas));
  return new Map(linhas.map((l) => [l.personId, l]));
}

/** Manda (ou só registra, no ensaio) e devolve o status. */
async function despachar(o: OpcoesEmail, para: string, e: EmailMontado): Promise<{ status: "ensaio" | "enviado" | "falhou"; erro: string | null }> {
  if (o.modo === "ensaio" || !o.enviar) return { status: "ensaio", erro: null };
  try {
    await o.enviar(para, e);
    return { status: "enviado", erro: null };
  } catch (error) {
    return { status: "falhou", erro: (error as Error).message.slice(0, 200) };
  }
}

export async function enviarAvisosPorEmail(db: Db, o: OpcoesEmail, agora = new Date()): Promise<{ emails: number; avisos: number; ignorados: number; falhas: number }> {
  const r = { emails: 0, avisos: 0, ignorados: 0, falhas: 0 };
  const n = schema.notifications;
  const limite = new Date(agora.getTime() - 20 * 3_600_000);
  // Velhos demais: não saem mais por e-mail.
  const velhos = await db.update(n).set({ emailStatus: "ignorado", emailedAt: agora }).where(and(isNull(n.emailStatus), lt(n.createdAt, limite))).returning({ id: n.id });
  r.ignorados += velhos.length;
  // Espera 2 min: avisos seguidos entram no mesmo e-mail e quem está no Omni já os leu.
  const fila = await db
    .select({ id: n.id, pessoa: n.personId, tipo: n.kind, titulo: n.title, corpo: n.body, tarefa: n.taskId, lido: n.readAt, email: schema.people.email, nome: schema.people.displayName, ativa: schema.people.active })
    .from(n)
    .innerJoin(schema.people, eq(schema.people.id, n.personId))
    .where(and(isNull(n.emailStatus), lt(n.createdAt, new Date(agora.getTime() - 2 * 60_000)), gt(n.createdAt, limite)))
    .orderBy(asc(n.createdAt))
    .limit(2000);
  const prefs = await preferencias(db, [...new Set(fila.map((f) => f.pessoa))]);
  const fora: string[] = [];
  const porPessoa = new Map<string, typeof fila>();
  for (const f of fila) {
    const chave = preferenciaDoAviso(f.tipo);
    const p = prefs.get(f.pessoa) ?? PADRAO;
    if (f.lido || !chave || !p[chave] || !f.ativa || !EMAIL_VALIDO.test(String(f.email))) {
      fora.push(f.id);
      continue;
    }
    porPessoa.set(f.pessoa, [...(porPessoa.get(f.pessoa) ?? []), f]);
  }
  if (fora.length) await db.update(n).set({ emailStatus: "ignorado", emailedAt: agora }).where(inArray(n.id, fora));
  r.ignorados += fora.length;

  for (const [pessoa, itens] of porPessoa) {
    const para = String(itens[0]!.email);
    const montado = emailDeAvisos({ app: o.app, nome: itens[0]!.nome.split(" ")[0] ?? itens[0]!.nome, itens: itens.map((i) => ({ titulo: i.titulo, corpo: i.corpo, tarefaId: i.tarefa })) });
    const { status, erro } = await despachar(o, para, montado);
    const ids = itens.map((i) => i.id);
    await db.insert(schema.notificationEmails).values({ personId: pessoa, kind: "avisos", toAddress: para, subject: montado.assunto, notificationIds: ids, mode: o.modo, status, error: erro });
    if (status === "falhou") {
      r.falhas += 1; // ficam na fila e tentam de novo na próxima rodada (até 20 h)
      continue;
    }
    await db.update(n).set({ emailStatus: status, emailedAt: agora }).where(inArray(n.id, ids));
    r.emails += 1;
    r.avisos += ids.length;
  }
  return r;
}

/** Segunda da semana de `hoje` (AAAA-MM-DD). */
const segundaDe = (hoje: string) => addDays(hoje, -((new Date(`${hoje}T12:00:00Z`).getUTCDay() + 6) % 7));

export async function enviarResumoSemanal(db: Db, o: OpcoesEmail, tipo: "atrasadas" | "semana", hoje: string): Promise<{ emails: number; falhas: number }> {
  const r = { emails: 0, falhas: 0 };
  const inicio = segundaDe(hoje);
  const fim = addDays(inicio, 6);
  // Atribuídas à pessoa: responsável, ou a caixa pessoal dela sem responsável. Projeto arquivado não entra.
  const linhas = (
    await db.execute<{ pessoa: string; email: string; nome: string; id: string; titulo: string; projeto: string | null; data: string; prioridade: number }>(sql`
      SELECT pe.id AS pessoa, pe.email::text AS email, pe.display_name AS nome, t.id, t.content AS titulo, tp.name AS projeto,
             t.due_date::text AS data, t.priority AS prioridade
        FROM tasks t
        JOIN people pe ON pe.id = coalesce(t.assignee_person_id, CASE WHEN t.project_id IS NULL THEN t.owner_person_id END)
        LEFT JOIN task_projects tp ON tp.id = t.project_id
       WHERE NOT t.completed AND pe.active AND (tp.id IS NULL OR tp.archived_at IS NULL)
         AND ${tipo === "atrasadas" ? sql`t.due_date < ${hoje}::date` : sql`t.due_date BETWEEN ${inicio}::date AND ${fim}::date`}
       ORDER BY pe.id, t.due_date, t.priority`)
  ).rows;
  const porPessoa = new Map<string, typeof linhas>();
  for (const l of linhas) porPessoa.set(l.pessoa, [...(porPessoa.get(l.pessoa) ?? []), l]);
  const prefs = await preferencias(db, [...porPessoa.keys()]);
  const kind = tipo === "atrasadas" ? "semanal_atrasadas" : "semanal_semana";
  for (const [pessoa, tarefas] of porPessoa) {
    const para = tarefas[0]!.email;
    if (!(prefs.get(pessoa) ?? PADRAO).resumoSemanal || !EMAIL_VALIDO.test(para)) continue;
    // Só o que saiu (ou foi ensaiado) leva a chave: falha não bloqueia a próxima tentativa.
    const dedupe = `${kind}:${pessoa}:${inicio}`;
    const [ja] = await db.select({ id: schema.notificationEmails.id }).from(schema.notificationEmails).where(eq(schema.notificationEmails.dedupeKey, dedupe));
    if (ja) continue;
    const nome = tarefas[0]!.nome.split(" ")[0] ?? tarefas[0]!.nome;
    const lista: TarefaEmail[] = tarefas.slice(0, 200).map((t) => ({ id: t.id, titulo: t.titulo, projeto: t.projeto, data: t.data, prioridade: t.prioridade }));
    const montado = tipo === "atrasadas" ? emailSemanalAtrasadas({ app: o.app, nome, hoje, tarefas: lista }) : emailSemanalDaSemana({ app: o.app, nome, inicio, fim, tarefas: lista });
    const { status, erro } = await despachar(o, para, montado);
    await db
      .insert(schema.notificationEmails)
      .values({ personId: pessoa, kind, toAddress: para, subject: montado.assunto, taskCount: lista.length, mode: o.modo, status, error: erro, dedupeKey: status === "falhou" ? null : dedupe })
      .onConflictDoNothing();
    if (status === "falhou") r.falhas += 1;
    else r.emails += 1;
  }
  return r;
}
