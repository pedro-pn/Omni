import { trechoDeChegada, tituloMissao, type BusinessCalendar } from "@omni/core";
import { schema, type Db } from "@omni/db";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

/**
 * Chegada da equipe pelo grupo do WhatsApp (job `ia-chegadas`, INSTRUCOES §7:
 * "líder de campo escreve no grupo algo como chegamos"). Mensagem recebida num
 * grupo ligado a uma missão que ainda não começou em campo e que parece chegada
 * (`trechoDeChegada`, o FIELD_RX do protótipo) vira a pergunta `chegada_grupo`
 * ao líder de projetos no Interno, citando a mensagem. Uma por missão e dia; a
 * publicação segue a janela útil (ia-publicar). Sem LLM: só a frase.
 */
export async function detectarChegadas(db: Db, cal: BusinessCalendar, agora = new Date()): Promise<{ lidas: number; perguntas: number }> {
  const m = schema.missions;
  const msg = schema.whatsappMessages;
  const recentes = await db
    .select({
      id: msg.id,
      texto: msg.body,
      autor: msg.authorName,
      em: msg.sentAt,
      missao: m.id,
      codigo: m.code,
      cliente: m.clientName,
    })
    .from(msg)
    .innerJoin(schema.whatsappChats, eq(schema.whatsappChats.id, msg.chatId))
    .innerJoin(schema.whatsappChatMissions, eq(schema.whatsappChatMissions.chatId, schema.whatsappChats.id))
    .innerJoin(m, eq(m.id, schema.whatsappChatMissions.missionId))
    .where(
      and(
        eq(msg.fromMe, false),
        eq(msg.kind, "texto"),
        eq(schema.whatsappChats.isGroup, true),
        gt(msg.sentAt, new Date(agora.getTime() - 36 * 3_600_000)),
        eq(m.isActive, true),
        isNull(m.cycleClosedAt),
        or(isNull(m.executedAtHeadquarters), eq(m.executedAtHeadquarters, false)),
        // Ainda não começou em campo: mobilizando, ou mobilizada sem início registrado.
        or(eq(m.stage, "MOBILIZATION"), and(isNull(m.startedAt), sql`${m.actualMobilizationDate} >= current_date - 30`)),
      ),
    )
    .orderBy(desc(msg.sentAt))
    .limit(500);

  const porMissao = new Map<string, (typeof recentes)[number]>();
  for (const r of recentes) {
    if (porMissao.has(r.missao)) continue; // a mais recente que parece chegada, por missão
    if (trechoDeChegada(r.texto)) porMissao.set(r.missao, r);
  }
  if (!porMissao.size) return { lidas: recentes.length, perguntas: 0 };

  // Quem já confirmou que a equipe toda chegou não é perguntado de novo.
  const confirmadas = new Set(
    (
      await db
        .select({ missao: schema.aiQuestions.missionId, resposta: schema.aiQuestions.answer })
        .from(schema.aiQuestions)
        .where(and(inArray(schema.aiQuestions.missionId, [...porMissao.keys()]), inArray(schema.aiQuestions.flow, ["chegada_grupo", "chegada_restante"]), eq(schema.aiQuestions.status, "respondida")))
    )
      .filter((q) => (q.resposta as { opcao?: string } | null)?.opcao === "todos")
      .map((q) => q.missao),
  );

  let perguntas = 0;
  for (const [missao, r] of porMissao) {
    if (confirmadas.has(missao)) continue;
    const dia = cal.dateKeyOf(r.em);
    const [q] = await db
      .insert(schema.aiQuestions)
      .values({
        missionId: missao,
        flow: "chegada_grupo",
        dedupeKey: `chegada_grupo:${missao}:${dia}`,
        dueAt: cal.nextSendSlot(agora),
        addressedTo: { papel: "LEADER" },
        payload: {
          missao: { codigo: r.codigo, titulo: tituloMissao(r.codigo, r.cliente) },
          chegada: { autor: r.autor?.trim() || "Alguém do grupo", trecho: trechoDeChegada(r.texto)!, em: r.em.toISOString() },
        },
        motivoData: "Mensagem de chegada no grupo do WhatsApp",
      })
      .onConflictDoNothing({ target: schema.aiQuestions.dedupeKey })
      .returning({ id: schema.aiQuestions.id });
    if (q) perguntas += 1;
  }
  return { lidas: recentes.length, perguntas };
}
