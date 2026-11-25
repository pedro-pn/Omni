import {
  entradaConferirAlerta,
  ESQUEMA_CONFERIR_ALERTA,
  rdosQueDisparam,
  SISTEMA_CONFERIR_ALERTA,
  textoDoDisparo,
  validarConferencia,
  type BusinessCalendar,
  type RegraAlertaIA,
} from "@omni/core";
import { schema, type Db } from "@omni/db";
import { LlmError, type Llm } from "@omni/integrations/openai";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * Alertas pedidos à IA (@IA, /alerta): para cada alerta ativo, lê os RDOs novos
 * da missão contra a regra (LLM, trecho conferido no texto), decide o disparo
 * (N RDOs seguidos sem a informação, ou um RDO com ela) e publica no canal só
 * na janela útil, marcando quem a regra pede e avisando no sino/celular.
 */

const SEM_CREDITO = new Set(["insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached", "invalid_api_key"]);

type Rdo = { id: string; report_type: string; report_number: string | null; report_date: string; daily_description: string | null };

export type ResultadoAlertas = { alertas: number; lidos: number; disparos: number; erros: number; parouSemCredito: boolean };

export async function conferirAlertas(db: Db, llm: Llm, opcoes: { modelo: string; maxLeiturasPorRodada?: number }): Promise<ResultadoAlertas> {
  const r: ResultadoAlertas = { alertas: 0, lidos: 0, disparos: 0, erros: 0, parouSemCredito: false };
  let orcamento = opcoes.maxLeiturasPorRodada ?? 60;
  const ativos = await db.select().from(schema.aiAlerts).where(eq(schema.aiAlerts.status, "ativo"));
  for (const alerta of ativos) {
    r.alertas += 1;
    const regra = alerta.spec as RegraAlertaIA;
    const rdos = (
      await db.execute<Rdo>(sql`
        SELECT id, report_type, report_number, report_date::text, daily_description FROM reports
         WHERE mission_id = ${alerta.missionId} AND report_type LIKE 'RDO%' AND length(coalesce(daily_description, '')) >= 30
           ${alerta.afterDate ? sql`AND report_date > ${alerta.afterDate}::date` : sql``}
         ORDER BY report_date DESC, id DESC LIMIT 30`)
    ).rows;
    // Recém-ativado: começa pelos últimos N RDOs (o alerta já vale para o que está acontecendo).
    const janela = (alerta.afterDate ? rdos : rdos.slice(0, regra.dias)).reverse();
    if (!janela.length) continue;
    const feitos = new Map(
      (
        await db
          .select()
          .from(schema.aiAlertChecks)
          .where(and(eq(schema.aiAlertChecks.alertId, alerta.id), inArray(schema.aiAlertChecks.reportId, janela.map((x) => x.id))))
      ).map((c) => [c.reportId, c.present]),
    );
    for (const rdo of janela) {
      if (feitos.has(rdo.id) || orcamento <= 0) continue;
      try {
        const resposta = await llm.estruturado<unknown>({
          modelo: opcoes.modelo,
          sistema: SISTEMA_CONFERIR_ALERTA,
          entrada: entradaConferirAlerta(regra, alerta.examples, { data: rdo.report_date, texto: rdo.daily_description ?? "" }),
          nome: "conferir_alerta",
          esquema: ESQUEMA_CONFERIR_ALERTA as unknown as Record<string, unknown>,
        });
        const v = validarConferencia(resposta.dados, rdo.daily_description ?? "");
        await db.insert(schema.llmCalls).values({
          purpose: "alerta_conferir",
          model: resposta.modelo,
          inputTokens: resposta.tokensEntrada,
          outputTokens: resposta.tokensSaida,
          durationMs: resposta.duracaoMs,
          outcome: "ok",
          missionId: alerta.missionId,
          dataIds: { alertId: alerta.id, reportId: rdo.id },
        });
        await db.insert(schema.aiAlertChecks).values({ alertId: alerta.id, reportId: rdo.id, present: v.presente, quote: v.trecho, model: resposta.modelo }).onConflictDoNothing();
        feitos.set(rdo.id, v.presente);
        orcamento -= 1;
        r.lidos += 1;
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        r.erros += 1;
        await db.insert(schema.llmCalls).values({
          purpose: "alerta_conferir",
          model: opcoes.modelo,
          outcome: "erro",
          errorCode: error.code ?? String(error.status),
          missionId: alerta.missionId,
          dataIds: { alertId: alerta.id, reportId: rdo.id },
        });
        if (SEM_CREDITO.has(error.code ?? "")) {
          r.parouSemCredito = true;
          return r;
        }
      }
    }
    // Só decide com a janela inteira conferida (em ordem).
    if (janela.some((x) => !feitos.has(x.id))) continue;
    const disparo = rdosQueDisparam(
      regra,
      janela.map((x) => ({ reportId: x.id, data: x.report_date, presente: feitos.get(x.id)! })),
    );
    // Sem disparo num alerta recém-ativado: fixa o ponto de partida no RDO mais recente lido.
    const ultimo = janela.at(-1)!.report_date;
    if (!disparo) {
      if (!alerta.afterDate && regra.tipo === "presenca") await db.update(schema.aiAlerts).set({ afterDate: ultimo }).where(eq(schema.aiAlerts.id, alerta.id));
      continue;
    }
    const dataDoUltimo = janela.find((x) => x.id === disparo.at(-1))!.report_date;
    await db.transaction(async (tx) => {
      await tx.insert(schema.aiAlertFires).values({ alertId: alerta.id, reportIds: disparo });
      // O próximo disparo só conta RDOs depois destes.
      await tx.update(schema.aiAlerts).set({ afterDate: dataDoUltimo, fires: sql`${schema.aiAlerts.fires} + 1` }).where(eq(schema.aiAlerts.id, alerta.id));
    });
    r.disparos += 1;
  }
  return r;
}

const PAPEL_NOME = { LEADER: "líder de projetos", PLANNER: "gestor de contrato", FIELD_OPERATOR: "líder de campo" } as const;

/** Quem marcar: nome para o texto e pessoas do Omni para o aviso. */
async function quemMarcar(db: Db, missionId: string, regra: RegraAlertaIA, criador: string): Promise<{ nome: string; pessoas: string[] }> {
  if (regra.marcar === "eu") {
    const [p] = await db.select({ nome: schema.people.displayName }).from(schema.people).where(eq(schema.people.id, criador));
    return { nome: `@${p?.nome.split(" ")[0] ?? "você"}`, pessoas: [criador] };
  }
  const responsaveis = await db
    .select({ name: schema.missionResponsibles.name, email: schema.missionResponsibles.email })
    .from(schema.missionResponsibles)
    .where(and(eq(schema.missionResponsibles.missionId, missionId), eq(schema.missionResponsibles.role, regra.marcar)));
  const emails = responsaveis.map((x) => x.email).filter((e): e is string => Boolean(e));
  const pessoas = emails.length
    ? (await db.select({ id: schema.people.id }).from(schema.people).where(and(inArray(sql`lower(${schema.people.email})`, emails.map((e) => e.toLowerCase())), eq(schema.people.active, true)))).map((x) => x.id)
    : [];
  const nomes = responsaveis.map((x) => `@${x.name.split(" ")[0]}`);
  // Ninguém no papel (ou sem conta no Omni): avisa quem pediu.
  return { nome: nomes.length ? `${nomes.join(", ")} (${PAPEL_NOME[regra.marcar]})` : `${PAPEL_NOME[regra.marcar]} (não definido no filtroAPP)`, pessoas: pessoas.length ? pessoas : [criador] };
}

/** Publica os disparos pendentes (só na janela útil). */
export async function publicarDisparos(db: Db, cal: BusinessCalendar, agora: Date = new Date()): Promise<{ publicados: number }> {
  if (!cal.isWithinWindow(agora)) return { publicados: 0 };
  const pendentes = await db
    .select({ f: schema.aiAlertFires, a: schema.aiAlerts, code: schema.missions.code })
    .from(schema.aiAlertFires)
    .innerJoin(schema.aiAlerts, eq(schema.aiAlerts.id, schema.aiAlertFires.alertId))
    .innerJoin(schema.missions, eq(schema.missions.id, schema.aiAlerts.missionId))
    .where(eq(schema.aiAlertFires.status, "pendente"));
  let publicados = 0;
  for (const { f, a, code } of pendentes) {
    if (a.status !== "ativo") {
      await db.update(schema.aiAlertFires).set({ status: "publicado" }).where(eq(schema.aiAlertFires.id, f.id));
      continue;
    }
    const regra = a.spec as RegraAlertaIA;
    const quem = await quemMarcar(db, a.missionId, regra, a.createdBy);
    const rdos = (await db.select().from(schema.reports).where(inArray(schema.reports.id, f.reportIds)))
      .sort((x, y) => String(x.reportDate).localeCompare(String(y.reportDate)))
      .map((x) => ({ nome: x.reportNumber ? (/^\d/.test(x.reportNumber) ? `${x.reportType} nº ${x.reportNumber}` : x.reportNumber) : x.reportType, data: String(x.reportDate) }));
    const texto = textoDoDisparo(regra, quem.nome, rdos, a.fires);
    await db.transaction(async (tx) => {
      const [reclamado] = await tx
        .update(schema.aiAlertFires)
        .set({ status: "publicado" })
        .where(and(eq(schema.aiAlertFires.id, f.id), eq(schema.aiAlertFires.status, "pendente")))
        .returning({ id: schema.aiAlertFires.id });
      if (!reclamado) return;
      const [m] = await tx
        .insert(schema.missionMessages)
        .values({ missionId: a.missionId, channel: a.channel, authorPersonId: null, kind: "ia", body: texto, alertFireId: f.id })
        .returning({ id: schema.missionMessages.id });
      await tx.update(schema.aiAlertFires).set({ messageId: m!.id }).where(eq(schema.aiAlertFires.id, f.id));
      await tx
        .insert(schema.notifications)
        .values(
          quem.pessoas.map((p) => ({
            personId: p,
            kind: "ia_alerta" as const,
            title: `Alerta da IA · Missão ${code}`,
            body: regra.tipo === "ausencia" ? `Não veio nos RDOs: ${regra.oQue}` : `Apareceu no RDO: ${regra.oQue}`,
            missionId: a.missionId,
            dedupeKey: `ia_alerta:${f.id}:${p}`,
          })),
        )
        .onConflictDoNothing();
      publicados += 1;
    });
  }
  return { publicados };
}
