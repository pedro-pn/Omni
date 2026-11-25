import {
  entradaResumoReuniao,
  ESQUEMA_RESUMO_REUNIAO,
  SISTEMA_RESUMO_REUNIAO,
  textoDoResumo,
  validarResumo,
  vincularEmail,
  VERSAO_PROMPT_REUNIAO,
  vttParaTexto,
  type BusinessCalendar,
} from "@omni/core";
import { schema, type Db } from "@omni/db";
import { GraphError, type EventoAgenda, type GraphClient } from "@omni/integrations/graph";
import { LlmError, type Llm } from "@omni/integrations/openai";
import { and, eq, gte, inArray, isNull, lt, notExists, notInArray, sql } from "drizzle-orm";

import { missoesVinculaveis } from "./outlook-emails.ts";

/**
 * Reuniões do Teams da missão (Fases 4 e 8).
 *
 * 1. `syncReunioes`: lê a agenda das caixas cadastradas (30 dias atrás → 14 à
 *    frente) e guarda só os eventos que se ligam a uma missão, pelas mesmas
 *    regras dos e-mails (número no título ou no convite, proposta, NF, domínio
 *    do cliente entre os participantes).
 * 2. `resumirReunioes`: para a reunião do Teams já encerrada, procura a
 *    transcrição; havendo, o LLM faz o resumo (decisões e pendências). A
 *    transcrição não é guardada. O resumo vai para o canal Gerencial das
 *    missões ligadas, só na janela útil.
 *
 * Acesso às transcrições desligado no tenant (403 GraphAccessToTranscriptsDisabled):
 * marca a reunião e para a rodada — nada a fazer até um administrador ligar.
 */

export const DIAS_ATRAS = 30;
export const DIAS_A_FRENTE = 14;
/** Espera depois do fim da reunião (a transcrição demora a ficar pronta). */
const ESPERA_FIM_MIN = 15;
/** Por quanto tempo procurar a transcrição de uma reunião (tentativas de hora em hora). */
const MAX_TENTATIVAS = 24;
const SEM_CREDITO = new Set(["insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached", "invalid_api_key"]);

export type FonteAgenda = Pick<GraphClient, "agenda">;
export type FonteTranscricoes = Pick<GraphClient, "usuarioId" | "reuniaoOnline" | "transcricoes" | "conteudoTranscricao">;
export type ResultadoReunioes = { caixas: number; eventos: number; guardadas: number; removidas: number; erros: number };
export type ResultadoResumos = { verificadas: number; resumidas: number; publicadas: number; semTranscricao: number; acessoDesligado: boolean; erros: number };

const pessoa = (p: EventoAgenda["organizer"]) =>
  p?.emailAddress.address ? { nome: p.emailAddress.name ?? null, endereco: p.emailAddress.address.toLowerCase() } : null;

export async function syncReunioes(db: Db, fonte: FonteAgenda, opcoes: { now?: () => Date } = {}): Promise<ResultadoReunioes> {
  const agora = (opcoes.now ?? (() => new Date()))();
  const r: ResultadoReunioes = { caixas: 0, eventos: 0, guardadas: 0, removidas: 0, erros: 0 };
  const caixas = await db.select().from(schema.mailMailboxes).where(eq(schema.mailMailboxes.active, true));
  if (!caixas.length) return r;
  const missoes = await missoesVinculaveis(db);
  const inicio = new Date(agora.getTime() - DIAS_ATRAS * 86_400_000);
  const fim = new Date(agora.getTime() + DIAS_A_FRENTE * 86_400_000);

  for (const caixa of caixas) {
    r.caixas += 1;
    let eventos: EventoAgenda[];
    try {
      eventos = await fonte.agenda(caixa.email, inicio, fim);
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      r.erros += 1;
      continue; // o erro da caixa já aparece pelos e-mails (mesmo acesso)
    }
    r.eventos += eventos.length;
    const vistos: string[] = [];
    for (const e of eventos) {
      if (e.isCancelled || !e.iCalUId) continue;
      const organizador = pessoa(e.organizer);
      const participantes = (e.attendees ?? []).map(pessoa).filter((p): p is NonNullable<typeof p> => Boolean(p));
      const vinculos = vincularEmail(
        {
          assunto: e.subject ?? "",
          texto: e.bodyPreview ?? "",
          enderecos: [organizador?.endereco, ...participantes.map((p) => p.endereco)].filter((x): x is string => Boolean(x)),
        },
        missoes,
      );
      if (!vinculos.length) continue;
      const t = schema.meetings;
      const joinUrl = e.isOnlineMeeting ? (e.onlineMeeting?.joinUrl ?? null) : null;
      const v = {
        subject: e.subject ?? null,
        startsAt: new Date(`${e.start.dateTime.replace(/Z$/, "")}Z`),
        endsAt: new Date(`${e.end.dateTime.replace(/Z$/, "")}Z`),
        organizerName: organizador?.nome ?? null,
        organizerAddress: organizador?.endereco ?? null,
        attendees: participantes,
        joinUrl,
        bodyPreview: (e.bodyPreview ?? "").slice(0, 300) || null,
      };
      const [linha] = await db
        .insert(t)
        .values({ icalUid: e.iCalUId, ...v, transcriptStatus: joinUrl ? "pendente" : "sem_link" })
        .onConflictDoUpdate({ target: t.icalUid, set: v })
        .returning({ id: t.id });
      const meetingId = linha!.id;
      vistos.push(e.id);
      await db
        .insert(schema.meetingCopies)
        .values({ mailboxId: caixa.id, eventId: e.id, meetingId })
        .onConflictDoUpdate({ target: [schema.meetingCopies.mailboxId, schema.meetingCopies.eventId], set: { meetingId } });
      await db.delete(schema.meetingMissions).where(eq(schema.meetingMissions.meetingId, meetingId));
      await db.insert(schema.meetingMissions).values(vinculos.map((x) => ({ meetingId, missionId: x.missionId, motivo: x.motivo, detalhe: x.detalhe })));
      r.guardadas += 1;
    }
    // Eventos da janela que sumiram da agenda (cancelados, apagados, sem vínculo agora).
    const c = schema.meetingCopies;
    const naJanela = db
      .select({ id: schema.meetings.id })
      .from(schema.meetings)
      .where(and(gte(schema.meetings.startsAt, inicio), lt(schema.meetings.startsAt, fim)));
    const tiradas = await db
      .delete(c)
      .where(and(eq(c.mailboxId, caixa.id), inArray(c.meetingId, naJanela), vistos.length ? notInArray(c.eventId, vistos) : undefined))
      .returning({ meetingId: c.meetingId });
    if (tiradas.length) {
      const orfas = await db
        .delete(schema.meetings)
        .where(
          and(
            inArray(schema.meetings.id, tiradas.map((x) => x.meetingId)),
            isNull(schema.meetings.summarizedAt), // reunião já resumida fica (o resumo foi publicado)
            notExists(db.select({ x: sql`1` }).from(c).where(eq(c.meetingId, schema.meetings.id))),
          ),
        )
        .returning({ id: schema.meetings.id });
      r.removidas += orfas.length;
    }
  }
  return r;
}

export async function resumirReunioes(
  db: Db,
  fonte: FonteTranscricoes,
  llm: Llm | null,
  cal: BusinessCalendar,
  opcoes: { modelo: string; now?: () => Date; maxPorRodada?: number },
): Promise<ResultadoResumos> {
  const agora = (opcoes.now ?? (() => new Date()))();
  const r: ResultadoResumos = { verificadas: 0, resumidas: 0, publicadas: 0, semTranscricao: 0, acessoDesligado: false, erros: 0 };
  const m = schema.meetings;
  const candidatas = await db
    .select()
    .from(m)
    .where(
      and(
        sql`${m.joinUrl} IS NOT NULL`,
        inArray(m.transcriptStatus, ["pendente", "sem_transcricao", "acesso_desligado", "sem_acesso", "erro"]),
        lt(m.endsAt, new Date(agora.getTime() - ESPERA_FIM_MIN * 60_000)),
        gte(m.endsAt, new Date(agora.getTime() - DIAS_ATRAS * 86_400_000)),
        lt(m.transcriptAttempts, MAX_TENTATIVAS),
        sql`(${m.transcriptCheckedAt} IS NULL OR ${m.transcriptCheckedAt} < ${new Date(agora.getTime() - 55 * 60_000)})`,
      ),
    )
    .orderBy(m.endsAt)
    .limit(opcoes.maxPorRodada ?? 20);

  const marcar = (id: string, status: (typeof m.$inferSelect)["transcriptStatus"], extra: Partial<typeof m.$inferInsert> = {}) =>
    db
      .update(m)
      .set({ transcriptStatus: status, transcriptCheckedAt: agora, transcriptAttempts: sql`${m.transcriptAttempts} + 1`, ...extra })
      .where(eq(m.id, id));

  for (const c of candidatas) {
    r.verificadas += 1;
    let texto: string;
    let organizadorId = c.organizerUserId;
    let reuniaoId = c.onlineMeetingId;
    try {
      if (!organizadorId) organizadorId = c.organizerAddress ? await fonte.usuarioId(c.organizerAddress) : null;
      // Organizador de fora da empresa: a reunião não é do nosso tenant.
      if (!organizadorId) {
        await marcar(c.id, "sem_acesso", { transcriptAttempts: MAX_TENTATIVAS });
        continue;
      }
      if (!reuniaoId) reuniaoId = await fonte.reuniaoOnline(organizadorId, c.joinUrl!);
      if (!reuniaoId) {
        await marcar(c.id, "sem_acesso", { organizerUserId: organizadorId });
        continue;
      }
      const lista = await fonte.transcricoes(organizadorId, reuniaoId);
      if (!lista.length) {
        r.semTranscricao += 1;
        await marcar(c.id, "sem_transcricao", { organizerUserId: organizadorId, onlineMeetingId: reuniaoId });
        continue;
      }
      // Reunião retomada pode ter mais de uma transcrição: junta na ordem.
      const partes: string[] = [];
      for (const t of [...lista].sort((a, b) => (a.criadaEm ?? "").localeCompare(b.criadaEm ?? ""))) {
        partes.push(vttParaTexto(await fonte.conteudoTranscricao(organizadorId, reuniaoId, t.id)));
      }
      texto = partes.filter(Boolean).join("\n");
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      if (error.codigoInterno === "GraphAccessToTranscriptsDisabled") {
        // Vale para o tenant inteiro: não conta como tentativa.
        r.acessoDesligado = true;
        await db.update(m).set({ transcriptStatus: "acesso_desligado", transcriptCheckedAt: agora, organizerUserId: organizadorId, onlineMeetingId: reuniaoId }).where(eq(m.id, c.id));
        break;
      }
      r.erros += 1;
      // 403/404: sem política de acesso do app para o organizador, ou reunião vencida.
      await marcar(c.id, error.status === 403 || error.status === 404 ? "sem_acesso" : "erro", { organizerUserId: organizadorId, onlineMeetingId: reuniaoId });
      continue;
    }

    if (!llm || texto.length < 80) {
      await marcar(c.id, "disponivel", { organizerUserId: organizadorId, onlineMeetingId: reuniaoId, transcriptAttempts: MAX_TENTATIVAS });
      continue;
    }
    const data = cal.dateKeyOf(c.startsAt);
    const titulo = c.subject?.trim() || "Reunião sem título";
    const missaoId = (await db.select({ id: schema.meetingMissions.missionId }).from(schema.meetingMissions).where(eq(schema.meetingMissions.meetingId, c.id)).limit(1))[0]?.id ?? null;
    try {
      const resposta = await llm.estruturado<unknown>({
        modelo: opcoes.modelo,
        sistema: SISTEMA_RESUMO_REUNIAO,
        entrada: entradaResumoReuniao(titulo, data, texto),
        nome: "resumo_reuniao",
        esquema: ESQUEMA_RESUMO_REUNIAO as unknown as Record<string, unknown>,
      });
      await db.insert(schema.llmCalls).values({
        purpose: "reuniao_resumo",
        model: resposta.modelo,
        inputTokens: resposta.tokensEntrada,
        outputTokens: resposta.tokensSaida,
        durationMs: resposta.duracaoMs,
        outcome: "ok",
        missionId: missaoId,
        dataIds: { meetingId: c.id, prompt: VERSAO_PROMPT_REUNIAO },
      });
      const resumo = validarResumo(resposta.dados);
      if (!resumo) {
        r.erros += 1;
        await marcar(c.id, "erro", { organizerUserId: organizadorId, onlineMeetingId: reuniaoId });
        continue;
      }
      await marcar(c.id, "resumida", {
        organizerUserId: organizadorId,
        onlineMeetingId: reuniaoId,
        summary: resumo,
        summaryModel: resposta.modelo,
        summarizedAt: agora,
      });
      r.resumidas += 1;
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      r.erros += 1;
      await db.insert(schema.llmCalls).values({
        purpose: "reuniao_resumo",
        model: opcoes.modelo,
        outcome: "erro",
        errorCode: error.code ?? String(error.status),
        missionId: missaoId,
        dataIds: { meetingId: c.id, prompt: VERSAO_PROMPT_REUNIAO },
      });
      // Volta à fila sem gastar tentativa; sem crédito, para a rodada.
      await db.update(m).set({ transcriptStatus: "pendente", transcriptCheckedAt: agora, organizerUserId: organizadorId, onlineMeetingId: reuniaoId }).where(eq(m.id, c.id));
      if (SEM_CREDITO.has(error.code ?? "")) break;
    }
  }

  r.publicadas = await publicarResumos(db, cal, agora);
  return r;
}

/** Publica no Gerencial de cada missão ligada os resumos ainda não publicados (só na janela útil). */
export async function publicarResumos(db: Db, cal: BusinessCalendar, agora: Date): Promise<number> {
  if (!cal.isWithinWindow(agora)) return 0;
  const m = schema.meetings;
  const prontas = await db
    .select()
    .from(m)
    .where(and(eq(m.transcriptStatus, "resumida"), isNull(m.summaryPostedAt), sql`${m.summary} IS NOT NULL`));
  let publicadas = 0;
  for (const c of prontas) {
    await db.transaction(async (tx) => {
      const [reclamada] = await tx
        .update(m)
        .set({ summaryPostedAt: agora })
        .where(and(eq(m.id, c.id), isNull(m.summaryPostedAt)))
        .returning({ id: m.id });
      if (!reclamada) return;
      const missoes = await tx
        .selectDistinct({ id: schema.meetingMissions.missionId })
        .from(schema.meetingMissions)
        .where(eq(schema.meetingMissions.meetingId, c.id));
      const texto = textoDoResumo(c.subject?.trim() || "Reunião sem título", cal.dateKeyOf(c.startsAt), c.summary!);
      if (missoes.length) {
        await tx.insert(schema.missionMessages).values(missoes.map((x) => ({ missionId: x.id, channel: "gerencial" as const, authorPersonId: null, kind: "ia" as const, body: texto })));
      }
      publicadas += 1;
    });
  }
  return publicadas;
}
