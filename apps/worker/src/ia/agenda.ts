import {
  cicloEncerradoPeloFiltroApp,
  FLUXOS_COM_RETOMADA,
  FLUXOS_FORA_DA_AGENDA,
  FLUXOS_IA,
  JANELA_RDO_DIAS,
  fluxo,
  planejarPerguntas,
  planejarRetomadas,
  tituloMissao,
  type BusinessCalendar,
  type DadosFiltroApp,
  type Destino,
  type PayloadPergunta,
  type PerguntaPlanejada,
} from "@omni/core";
import { schema, type Db } from "@omni/db";
import { and, desc, eq, gte, inArray, isNull, like, lte, or, sql } from "drizzle-orm";

/**
 * Agenda da IA (Fase 5).
 * - planejarAgenda: encerra o ciclo das missões em que o Faturamento confirmou
 *   que não há mais pagamentos; cria as perguntas que cada missão ativa precisa
 *   (chave única impede duplicar) e cancela as agendadas que perderam o sentido
 *   (data mudou no filtroAPP, missão avançou de etapa, ciclo encerrado).
 * - publicarPerguntas: dentro da janela útil, publica no canal Interno as
 *   perguntas vencidas, endereçadas pelo papel da missão ou pela função. A
 *   função endereçada passa a ver o Interno da missão (migration 0008).
 */

// Só os fluxos que o planejador cria (a leitura dos RDOs agenda as próprias perguntas).
const FLUXOS = Object.keys(FLUXOS_IA).filter((f) => !FLUXOS_FORA_DA_AGENDA.has(f));
const UMA_POR_MISSAO = new Set(["medicao", "aprovacao", "saldo_medicao", "faturamento", "pagamentos"]);

/** Entrega B do filtroAPP por missão, com as datas no dia de São Paulo. */
async function carregarDadosFiltroApp(db: Db, ids: string[], cal: BusinessCalendar): Promise<Map<string, DadosFiltroApp>> {
  const mapa = new Map<string, DadosFiltroApp>();
  if (!ids.length) return mapa;
  const dia = (d: Date | null) => (d ? cal.dateKeyOf(d) : null);
  const de = (id: string) => {
    let d = mapa.get(id);
    if (!d) mapa.set(id, (d = { medicao: null, notas: [], romaneios: [], descargas: [], pendencias: null }));
    return d;
  };
  const [medicoes, notas, romaneios, descargas, pendencias] = await Promise.all([
    db.select().from(schema.missionMeasurements).where(inArray(schema.missionMeasurements.missionId, ids)),
    db
      .select({ m: schema.missionInvoices.missionId, d: schema.missionInvoices.dataEmissao })
      .from(schema.missionInvoices)
      .where(inArray(schema.missionInvoices.missionId, ids)),
    db.select().from(schema.missionRomaneios).where(inArray(schema.missionRomaneios.missionId, ids)),
    db.select().from(schema.missionUnloadings).where(inArray(schema.missionUnloadings.missionId, ids)),
    db.select().from(schema.missionPending).where(inArray(schema.missionPending.missionId, ids)),
  ]);
  for (const x of medicoes) {
    de(x.missionId).medicao = { situacao: x.situacao, enviadaEm: dia(x.sentAt), aprovadaEm: dia(x.approvedAt), saldoPendente: x.saldoPendente };
  }
  for (const x of notas) de(x.m).notas.push({ dataEmissao: dia(x.d)! });
  for (const x of romaneios) de(x.missionId).romaneios.push({ id: x.id, tipo: x.tipo, data: dia(x.data)!, emitidoEm: dia(x.emitidoEm) });
  for (const x of descargas) de(x.missionId).descargas.push({ romaneioId: x.romaneioId, tipo: x.tipo });
  for (const x of pendencias) {
    de(x.missionId).pendencias = {
      aPagar: x.aPagarQtd,
      aReceber: x.aReceberQtd,
      // Valor nulo = título parcial sem saldo confiável: não dá para dizer que está quitado.
      confiavel: (x.aPagarQtd === 0 || x.aPagarValor !== null) && (x.aReceberQtd === 0 || x.aReceberValor !== null),
    };
  }
  return mapa;
}

export async function planejarAgenda(
  db: Db,
  cal: BusinessCalendar,
  agora: Date = new Date(),
): Promise<{ criadas: number; canceladas: number }> {
  await encerrarCiclos(db);
  const missoes = await db
    .select()
    .from(schema.missions)
    .where(and(eq(schema.missions.isActive, true), isNull(schema.missions.cycleClosedAt)));
  const ids = missoes.map((m) => m.id);

  // Devolvidos na última semana e RDOs dos últimos dias (para notar o que não chegou).
  const limite = new Date(agora.getTime() - 7 * 86_400_000);
  const desdeRdo = cal.dateKeyOf(new Date(agora.getTime() - (JANELA_RDO_DIAS + 1) * 86_400_000));
  const relatoriosRecentes = ids.length
    ? await db
        .select()
        .from(schema.reports)
        .where(
          and(
            inArray(schema.reports.missionId, ids),
            or(
              and(eq(schema.reports.status, "RETURNED"), gte(schema.reports.returnedAt, limite)),
              and(like(schema.reports.reportType, "RDO%"), gte(schema.reports.reportDate, desdeRdo)),
            ),
          ),
        )
    : [];

  // Cobrança de RDO: só missões que já usam RDO, com a cópia dos relatórios em
  // dia (menos de 2 h) e sem outra cobrança de RDO esperando resposta.
  const [estado] = await db
    .select({ ultimo: schema.syncState.lastSuccessAt })
    .from(schema.syncState)
    .where(and(eq(schema.syncState.source, "filtroapp"), eq(schema.syncState.resource, "relatorios")));
  const relatoriosEmDia = Boolean(estado?.ultimo && agora.getTime() - estado.ultimo.getTime() < 2 * 3_600_000);
  const usamRdo = new Set(
    relatoriosEmDia && ids.length
      ? (
          await db
            .selectDistinct({ id: schema.reports.missionId })
            .from(schema.reports)
            .where(and(inArray(schema.reports.missionId, ids), like(schema.reports.reportType, "RDO%")))
        ).map((r) => r.id)
      : [],
  );
  const cobrancaAberta = new Set(
    ids.length
      ? (
          await db
            .selectDistinct({ id: schema.aiQuestions.missionId })
            .from(schema.aiQuestions)
            .where(and(eq(schema.aiQuestions.flow, "rdo_atrasado"), eq(schema.aiQuestions.status, "enviada")))
        ).map((r) => r.id)
      : [],
  );

  const respondidas = ids.length
    ? await db
        .select()
        .from(schema.aiQuestions)
        .where(
          and(
            inArray(schema.aiQuestions.missionId, ids),
            eq(schema.aiQuestions.status, "respondida"),
            inArray(schema.aiQuestions.flow, FLUXOS_COM_RETOMADA),
          ),
        )
    : [];

  // Entrega B do filtroAPP: o que ele já sabe de cada missão (a IA não pergunta isso).
  const dados = await carregarDadosFiltroApp(db, ids, cal);
  const dadosDa = (missionId: string) => dados.get(missionId);

  // Ciclo encerrado pelos dados: NF emitida depois do fim em campo e Omie sem pendências.
  const fechadas = new Set<string>();
  for (const m of missoes) {
    const fim = m.fieldCompletionDate;
    if (!cicloEncerradoPeloFiltroApp({ stage: m.stage, fimEmCampo: fim, dados: dadosDa(m.id) })) continue;
    const [fechada] = await db
      .update(schema.missions)
      .set({ cycleClosedAt: agora })
      .where(and(eq(schema.missions.id, m.id), isNull(schema.missions.cycleClosedAt)))
      .returning({ id: schema.missions.id });
    fechadas.add(m.id);
    if (fechada) {
      await publicarAvisoIA(db, m.id, "Ciclo da missão encerrado no Omni: NF emitida e nenhuma pendência no Omie (dados do filtroAPP). Deixo de acompanhar esta missão.");
    }
  }

  const planejadas: Array<PerguntaPlanejada & { missionId: string }> = [];
  for (const m of missoes) {
    if (fechadas.has(m.id)) continue;
    const relatorios = relatoriosRecentes
      .filter((r) => r.missionId === m.id)
      .map((r) => ({
        id: r.id,
        tipo: r.reportType,
        numero: r.reportNumber,
        data: r.reportDate,
        status: r.status,
        devolvidoEm: r.returnedAt?.toISOString() ?? null,
      }));
    const perguntas = planejarPerguntas(
      {
        id: m.id,
        codigo: m.code,
        titulo: tituloMissao(m.code, m.clientName),
        stage: m.stage,
        executadaNaSede: m.executedAtHeadquarters,
        mobilizacaoPlanejada: m.plannedMobilizationDate,
        mobilizacaoComercial: m.commercialExpectedMobilizationDate,
        mobilizacaoReal: m.actualMobilizationDate,
        inicioEmCampo: m.startedAt?.toISOString().slice(0, 10) ?? null,
        desmobilizacao: m.demobilizationDate ?? m.demobilizationAt?.toISOString().slice(0, 10) ?? null,
        fimEmCampo: m.fieldCompletionDate,
        trabalhaSabado: m.includesSaturday,
        trabalhaDomingo: m.includesSunday,
        cobrarRdo: usamRdo.has(m.id) && !cobrancaAberta.has(m.id),
        dados: dadosDa(m.id),
        chegadaConfirmada: respondidas.some(
          (q) => q.missionId === m.id && (q.flow === "chegada_grupo" || q.flow === "chegada_restante") && (q.answer as { opcao?: string } | null)?.opcao === "todos",
        ),
      },
      relatorios,
      cal,
      agora,
    );
    const retomadas = planejarRetomadas(
      respondidas
        .filter((q) => q.missionId === m.id)
        .map((q) => ({
          id: q.id,
          flow: q.flow,
          missaoId: m.id,
          answer: q.answer as { opcao?: string; nova_data?: string } | null,
          answeredAt: q.answeredAt,
          payload: q.payload as unknown as PayloadPergunta,
        })),
      cal,
      agora,
      dadosDa,
    );
    for (const p of [...perguntas, ...retomadas]) planejadas.push({ ...p, missionId: m.id });
  }

  // Uma pergunta aberta por fluxo nestas etapas: a mesma pergunta pode nascer
  // dos dados do filtroAPP e de uma resposta anterior (ex.: "NF emitida?").
  const abertas = new Set(
    ids.length
      ? (
          await db
            .select({ m: schema.aiQuestions.missionId, f: schema.aiQuestions.flow })
            .from(schema.aiQuestions)
            .where(and(inArray(schema.aiQuestions.missionId, ids), inArray(schema.aiQuestions.status, ["agendada", "enviada"])))
        ).map((x) => `${x.m}:${x.f}`)
      : [],
  );
  const existentes = new Set(
    planejadas.length
      ? (
          await db
            .select({ k: schema.aiQuestions.dedupeKey })
            .from(schema.aiQuestions)
            .where(inArray(schema.aiQuestions.dedupeKey, planejadas.map((p) => p.dedupeKey)))
        ).map((x) => x.k)
      : [],
  );

  let criadas = 0;
  for (const p of planejadas) {
    if (UMA_POR_MISSAO.has(p.flow) && !existentes.has(p.dedupeKey) && abertas.has(`${p.missionId}:${p.flow}`)) continue;
    const inseridas = await db
      .insert(schema.aiQuestions)
      .values({
        missionId: p.missionId,
        flow: p.flow,
        dedupeKey: p.dedupeKey,
        dueAt: p.dueAt,
        addressedTo: p.addressedTo,
        payload: p.payload as unknown as Record<string, unknown>,
        motivoData: p.motivoData,
      })
      .onConflictDoNothing({ target: schema.aiQuestions.dedupeKey })
      .returning({ id: schema.aiQuestions.id });
    criadas += inseridas.length;
    if (inseridas.length) abertas.add(`${p.missionId}:${p.flow}`);
  }

  // Agendada que não está mais no plano perdeu o sentido.
  const chaves = new Set(planejadas.map((p) => p.dedupeKey));
  const agendadas = await db
    .select({ id: schema.aiQuestions.id, dedupeKey: schema.aiQuestions.dedupeKey })
    .from(schema.aiQuestions)
    .where(and(eq(schema.aiQuestions.status, "agendada"), inArray(schema.aiQuestions.flow, FLUXOS)));
  const cancelar = agendadas.filter((q) => !chaves.has(q.dedupeKey)).map((q) => q.id);
  if (cancelar.length) {
    await db.update(schema.aiQuestions).set({ status: "cancelada" }).where(inArray(schema.aiQuestions.id, cancelar));
  }
  return { criadas, canceladas: cancelar.length };
}

/** Resposta que encerra o ciclo (ex.: "não há mais pagamentos") fecha a missão no Omni. */
async function encerrarCiclos(db: Db): Promise<void> {
  const encerram = Object.entries(FLUXOS_IA).flatMap(([flow, f]) =>
    f.opcoes.filter((o) => "encerraCiclo" in o && o.encerraCiclo).map((o) => ({ flow, opcao: o.id })),
  );
  for (const { flow, opcao } of encerram) {
    const rows = await db
      .select({ missionId: schema.aiQuestions.missionId, answeredAt: schema.aiQuestions.answeredAt })
      .from(schema.aiQuestions)
      .innerJoin(schema.missions, eq(schema.missions.id, schema.aiQuestions.missionId))
      .where(
        and(
          eq(schema.aiQuestions.flow, flow),
          eq(schema.aiQuestions.status, "respondida"),
          sql`${schema.aiQuestions.answer}->>'opcao' = ${opcao}`,
          isNull(schema.missions.cycleClosedAt),
        ),
      );
    for (const r of rows) {
      const [fechada] = await db
        .update(schema.missions)
        .set({ cycleClosedAt: r.answeredAt ?? new Date() })
        .where(and(eq(schema.missions.id, r.missionId), isNull(schema.missions.cycleClosedAt)))
        .returning({ id: schema.missions.id });
      if (fechada) {
        await publicarAvisoIA(db, r.missionId, "Ciclo da missão encerrado no Omni: não há mais pagamentos pendentes. Deixo de acompanhar esta missão.");
      }
    }
  }
}

/** Quem ocupa a função passa a ver o Interno da missão (app.canal_desde). */
export async function liberarFuncao(db: Pick<Db, "insert">, missionId: string, funcao: string, motivo: string): Promise<void> {
  await db.insert(schema.missionFunctionAccess).values({ missionId, functionCode: funcao, reason: motivo }).onConflictDoNothing();
}

const PAPEL: Record<"LEADER" | "PLANNER", string> = { LEADER: "Líder de projetos", PLANNER: "Gestor de contrato" };

/** Nome de quem ocupa o papel na missão ou a função hoje. */
export async function nomeDoDestino(db: Db, missionId: string, destino: Destino, hoje: string): Promise<string> {
  if ("papel" in destino) {
    const [r] = await db
      .select({ name: schema.missionResponsibles.name })
      .from(schema.missionResponsibles)
      .where(and(eq(schema.missionResponsibles.missionId, missionId), eq(schema.missionResponsibles.role, destino.papel)));
    return r?.name ?? `${PAPEL[destino.papel]} (não definido no filtroAPP)`;
  }
  const [f] = await db
    .select({ nome: schema.people.displayName, funcao: schema.functions.name })
    .from(schema.functionAssignments)
    .innerJoin(schema.people, eq(schema.people.id, schema.functionAssignments.personId))
    .innerJoin(schema.functions, eq(schema.functions.code, schema.functionAssignments.functionCode))
    .where(
      and(
        eq(schema.functionAssignments.functionCode, destino.funcao),
        lte(schema.functionAssignments.startsOn, hoje),
        or(isNull(schema.functionAssignments.endsOn), gte(schema.functionAssignments.endsOn, hoje)),
        eq(schema.people.active, true),
      ),
    )
    .orderBy(desc(schema.functionAssignments.isSubstitute))
    .limit(1);
  if (f) return `${f.nome} (${f.funcao})`;
  const [def] = await db.select({ name: schema.functions.name }).from(schema.functions).where(eq(schema.functions.code, destino.funcao));
  return `${def?.name ?? destino.funcao} (função vaga)`;
}

export async function publicarPerguntas(db: Db, cal: BusinessCalendar, agora: Date = new Date()): Promise<{ publicadas: number }> {
  if (!cal.isWithinWindow(agora)) return { publicadas: 0 };
  const hoje = cal.dateKeyOf(agora);
  const vencidas = await db
    .select()
    .from(schema.aiQuestions)
    .where(and(eq(schema.aiQuestions.status, "agendada"), lte(schema.aiQuestions.dueAt, agora)))
    .orderBy(schema.aiQuestions.dueAt)
    .limit(50);

  let publicadas = 0;
  for (const q of vencidas) {
    const definicao = fluxo(q.flow);
    if (!definicao) {
      await db.update(schema.aiQuestions).set({ status: "cancelada" }).where(eq(schema.aiQuestions.id, q.id));
      continue;
    }
    const destino = await nomeDoDestino(db, q.missionId, q.addressedTo, hoje);
    const pergunta = definicao.texto(q.payload as unknown as PayloadPergunta);
    const texto = `${destino}, ${pergunta.charAt(0).toLowerCase()}${pergunta.slice(1)}`;
    await db.transaction(async (tx) => {
      // Reclama a pergunta: se outra execução já publicou, não publica de novo.
      const [reclamada] = await tx
        .update(schema.aiQuestions)
        .set({ status: "enviada" })
        .where(and(eq(schema.aiQuestions.id, q.id), eq(schema.aiQuestions.status, "agendada")))
        .returning({ id: schema.aiQuestions.id });
      if (!reclamada) return;
      const [m] = await tx
        .insert(schema.missionMessages)
        .values({ missionId: q.missionId, channel: "interno", authorPersonId: null, kind: "ia", body: texto })
        .returning({ id: schema.missionMessages.id });
      await tx.update(schema.aiQuestions).set({ messageId: m!.id }).where(eq(schema.aiQuestions.id, q.id));
      if ("funcao" in q.addressedTo) await liberarFuncao(tx, q.missionId, q.addressedTo.funcao, q.flow);
      publicadas += 1;
    });
  }
  return { publicadas };
}

/** Usado pelo módulo de desvios para marcar pessoas no Interno. */
export async function publicarAvisoIA(db: Db, missionId: string, texto: string): Promise<void> {
  await db.insert(schema.missionMessages).values({ missionId, channel: "interno", authorPersonId: null, kind: "ia", body: texto });
}

