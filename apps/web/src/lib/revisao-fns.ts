import {
  addDays,
  alertasDaMissao,
  BusinessCalendar,
  escolherMetas,
  etapaResumo,
  periodoMeta,
  resumoMeta,
  segundaDaSemana,
  tituloMissao,
  type Alerta,
  type MissaoRevisao,
} from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, gte, inArray, isNull, like, lte, sql } from "drizzle-orm";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";
import { exigirModulo } from "../server/modulos.ts";

/**
 * Revisão semanal (Fase 9, primeira versão): uma linha por missão ativa com o
 * que o Omni já tem e os alertas (@omni/core revisao.ts). Só gerente e
 * diretoria (app.ve_gestao, migration 0017); valores em reais só por
 * app.financeiro_missoes. Da Gestão do filtroAPP (B6, 0018): avanço e meta por
 * semana, revisão semanal feita lá, alocações e horas do ponto; custos × avanço
 * e diária de stand-by só por app.custos_missoes().
 */

export type LinhaRevisao = {
  id: string;
  codigo: string;
  titulo: string;
  etapa: string;
  minha: boolean;
  avanco: number | null;
  avancoSemana: number | null;
  /**
   * Meta valendo hoje, como cadastrada no filtroAPP (ex.: "71,8 de 108 m"; ou
   * em p.p. nas metas antigas), e se a revisão semanal de lá foi feita.
   */
  semana: { meta: { texto: string; situacao: string; rotulo: string; periodo: string } | null; revisao: "feita" | "pendente" | null } | null;
  custo: { consumo: number | null; avancoFisico: number | null; realizado: number; previsto: number | null; ate: string } | null;
  equipe: { alocados: number; ponto: { semanaPassada: boolean; extrasMin: number; pessoas: number } | null };
  rdos: { semana: number; devolvidos: number; ultimo: string | null };
  qualidade: { abertos: number; altoImpacto: number; acaoVencida: number };
  medicao: { situacao: "SEM_MEDICAO" | "PREPARADA" | "ENVIADA" | "APROVADA"; enviadaEm: string | null; aprovadaEm: string | null } | null;
  notas: { total: number; atrasadas: number; emAberto: number };
  pendencias: { aPagar: number; aReceber: number } | null;
  perguntasSemResposta: number;
  tarefas: { abertas: number; atrasadas: number };
  financeiro: { aPagar: number | null; aReceber: number | null; notasEmAberto: number | null } | null;
  alertas: Alerta[];
};

export type Revisao = { semana: { inicio: string; fim: string }; geradaEm: string; linhas: LinhaRevisao[] };

const ABERTOS = ["ABERTO", "EM_ACAO", "EM_OBSERVACAO"];
const hojeSaoPaulo = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export const revisaoSemanal = createServerFn({ method: "GET" }).handler(async (): Promise<Revisao> => {
  const meuId = await personIdFromRequest(getRequest());
  if (!meuId) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  await exigirModulo(meuId, "revisao");
  const hoje = hojeSaoPaulo();
  // Semana de segunda a domingo, como no filtroAPP.
  const inicio = segundaDaSemana(hoje);
  const fim = addDays(inicio, 6);
  const passada = addDays(inicio, -7);

  return withPerson(getPool(), meuId, async (db) => {
    const [g] = (await db.execute<{ ok: boolean }>(sql`SELECT app.ve_gestao() AS ok`)).rows;
    if (!g?.ok) throw new ErroParaTela("A revisão semanal é para gerentes e diretoria.");

    const feriados = await db.select().from(schema.holidays);
    const cal = new BusinessCalendar({
      extraHolidays: feriados.map((f) => ({ date: f.date, name: f.name, scope: f.scope, city: f.city ?? undefined })),
    });

    const missoes = await db.select().from(schema.missions).where(eq(schema.missions.isActive, true));
    const ids = missoes.map((m) => m.id);
    if (!ids.length) return { semana: { inicio, fim }, geradaEm: new Date().toISOString(), linhas: [] };

    const [eu] = await db.select({ email: schema.people.email }).from(schema.people).where(eq(schema.people.id, meuId));
    const [minhas, rdos, devolvidos, qualidade, medicoes, notas, pend, historico, contagens, financeiro, semanas, ponto, alocados, condicoes, romaneios, custos] = await Promise.all([
      db
        .select({ m: schema.missionResponsibles.missionId })
        .from(schema.missionResponsibles)
        .where(and(inArray(schema.missionResponsibles.role, ["LEADER", "PLANNER"]), sql`lower(${schema.missionResponsibles.email}) = lower(${String(eu?.email ?? "")})`)),
      db
        .select({
          m: schema.reports.missionId,
          ultimo: sql<string | null>`max(${schema.reports.reportDate})::text`,
          semana: sql<number>`count(*) FILTER (WHERE ${schema.reports.reportDate} BETWEEN ${inicio} AND ${fim})::int`,
        })
        .from(schema.reports)
        .where(and(inArray(schema.reports.missionId, ids), like(schema.reports.reportType, "RDO%")))
        .groupBy(schema.reports.missionId),
      db
        .select({ m: schema.reports.missionId, n: sql<number>`count(*)::int` })
        .from(schema.reports)
        .where(and(inArray(schema.reports.missionId, ids), eq(schema.reports.status, "RETURNED")))
        .groupBy(schema.reports.missionId),
      db
        .select({
          m: schema.missionQualityRecords.missionId,
          abertos: sql<number>`count(*)::int`,
          alto: sql<number>`count(*) FILTER (WHERE ${schema.missionQualityRecords.impact} = 'ALTO')::int`,
          vencida: sql<number>`count(*) FILTER (WHERE ${schema.missionQualityRecords.actionDeadline} < ${hoje})::int`,
        })
        .from(schema.missionQualityRecords)
        .where(
          and(
            inArray(schema.missionQualityRecords.missionId, ids),
            isNull(schema.missionQualityRecords.deletedAt),
            inArray(schema.missionQualityRecords.status, ABERTOS),
          ),
        )
        .groupBy(schema.missionQualityRecords.missionId),
      db
        .select({
          m: schema.missionMeasurements.missionId,
          situacao: schema.missionMeasurements.situacao,
          sentAt: schema.missionMeasurements.sentAt,
          approvedAt: schema.missionMeasurements.approvedAt,
          saldo: schema.missionMeasurements.saldoPendente,
        })
        .from(schema.missionMeasurements)
        .where(inArray(schema.missionMeasurements.missionId, ids)),
      db
        .select({
          m: schema.missionInvoices.missionId,
          total: sql<number>`count(*)::int`,
          atrasadas: sql<number>`count(*) FILTER (WHERE ${schema.missionInvoices.situacaoRecebimento} = 'ATRASADA')::int`,
          emAberto: sql<number>`count(*) FILTER (WHERE ${schema.missionInvoices.situacaoRecebimento} IN ('EM_ABERTO', 'PARCIAL', 'ATRASADA'))::int`,
        })
        .from(schema.missionInvoices)
        .where(inArray(schema.missionInvoices.missionId, ids))
        .groupBy(schema.missionInvoices.missionId),
      db
        .select({ m: schema.missionPending.missionId, aPagar: schema.missionPending.aPagarQtd, aReceber: schema.missionPending.aReceberQtd })
        .from(schema.missionPending)
        .where(inArray(schema.missionPending.missionId, ids)),
      // Avanço de 7 dias atrás (o registro mais recente até lá).
      db
        .select({ m: schema.missionProgressHistory.missionId, dia: schema.missionProgressHistory.dia, p: schema.missionProgressHistory.progressPercent })
        .from(schema.missionProgressHistory)
        .where(
          and(
            inArray(schema.missionProgressHistory.missionId, ids),
            lte(schema.missionProgressHistory.dia, addDays(hoje, -7)),
            gte(schema.missionProgressHistory.dia, addDays(hoje, -21)),
          ),
        ),
      db.execute<{ mission_id: string; perguntas_sem_resposta: number; tarefas_atrasadas: number; tarefas_abertas: number }>(
        sql`SELECT * FROM app.contagens_revisao(${hoje}::date)`,
      ),
      db.execute<{ mission_id: string; a_pagar: string | null; a_receber: string | null; notas_em_aberto: string | null }>(
        sql`SELECT mission_id, a_pagar, a_receber, notas_em_aberto FROM app.financeiro_missoes()`,
      ),
      db
        .select()
        .from(schema.missionWeeklyProgress)
        // Quatro semanas: o período da meta pode não ser de segunda a domingo.
        .where(and(inArray(schema.missionWeeklyProgress.missionId, ids), gte(schema.missionWeeklyProgress.weekStart, addDays(inicio, -21)))),
      db
        .select()
        .from(schema.missionTimesheetWeeks)
        .where(and(inArray(schema.missionTimesheetWeeks.missionId, ids), inArray(schema.missionTimesheetWeeks.weekStart, [inicio, passada]))),
      // Alocados nesta semana (o plano oficial do Efetivo); sem datas, vale o período da missão.
      db
        .select({ m: schema.missionAllocations.missionId, n: sql<number>`count(DISTINCT ${schema.missionAllocations.collaboratorId})::int` })
        .from(schema.missionAllocations)
        .innerJoin(schema.missions, eq(schema.missions.id, schema.missionAllocations.missionId))
        .where(
          and(
            inArray(schema.missionAllocations.missionId, ids),
            isNull(schema.missionAllocations.deletedAt),
            sql`coalesce(${schema.missionAllocations.mobilizacao}, ${schema.missions.actualMobilizationDate}, ${schema.missions.plannedMobilizationDate}) <= ${fim}`,
            sql`coalesce(${schema.missionAllocations.desmobilizacao}, ${schema.missions.demobilizationDate}, ${fim}) >= ${inicio}`,
          ),
        )
        .groupBy(schema.missionAllocations.missionId),
      db
        .select({ m: schema.missionConditions.missionId, dias: schema.missionConditions.permanenciaPrevistaDias })
        .from(schema.missionConditions)
        .where(inArray(schema.missionConditions.missionId, ids)),
      db
        .select({
          m: schema.missionRomaneios.missionId,
          saida: sql<string | null>`min(${schema.missionRomaneios.data}) FILTER (WHERE ${schema.missionRomaneios.tipo} = 'SAIDA')`,
          retorno: sql<string | null>`max(${schema.missionRomaneios.data}) FILTER (WHERE ${schema.missionRomaneios.tipo} = 'RETORNO')`,
        })
        .from(schema.missionRomaneios)
        .where(inArray(schema.missionRomaneios.missionId, ids))
        .groupBy(schema.missionRomaneios.missionId),
      db.execute<{
        mission_id: string;
        custo_previsto: string | null;
        custo_total: string | null;
        custo_ate: string | null;
        avanco_fisico: string | null;
        consumo_do_custo: number | null;
        diaria_stand_by: string | null;
      }>(sql`SELECT mission_id, custo_previsto, custo_total, custo_ate::text, avanco_fisico, consumo_do_custo, diaria_stand_by FROM app.custos_missoes()`),
    ]);

    const minhasSet = new Set(minhas.map((x) => x.m));
    const por = <T extends { m: string }>(l: T[]) => new Map(l.map((x) => [x.m, x]));
    const [rdoM, devM, qualM, medM, notaM, pendM] = [por(rdos), por(devolvidos), por(qualidade), por(medicoes), por(notas), por(pend)];
    const contM = new Map(contagens.rows.map((x) => [x.mission_id, x]));
    const finM = new Map(financeiro.rows.map((x) => [x.mission_id, x]));
    const [aloM, condM, romM] = [por(alocados), por(condicoes), por(romaneios)];
    const custoM = new Map(custos.rows.map((x) => [x.mission_id, x]));
    const daSemana = <T extends { missionId: string; weekStart: string }>(l: T[], semana: string) =>
      new Map(l.filter((x) => x.weekStart === semana).map((x) => [x.missionId, x]));
    const [semAtual, semPassada, pontoAtual, pontoPassado] = [daSemana(semanas, inicio), daSemana(semanas, passada), daSemana(ponto, inicio), daSemana(ponto, passada)];
    const semanaPassada = new Map<string, number | null>();
    for (const h of [...historico].sort((a, b) => a.dia.localeCompare(b.dia))) semanaPassada.set(h.m, h.p);

    const linhas = missoes.map((m): LinhaRevisao => {
      const med = medM.get(m.id);
      const dia = (d: Date | null | undefined) => (d ? cal.dateKeyOf(d) : null);
      const medicao = med ? { situacao: med.situacao, enviadaEm: dia(med.sentAt), aprovadaEm: dia(med.approvedAt) } : null;
      const q = qualM.get(m.id);
      const c = contM.get(m.id);
      const f = finM.get(m.id);
      const r = rdoM.get(m.id);
      const sa = semAtual.get(m.id);
      const metas = escolherMetas(
        semanas.filter((s) => s.missionId === m.id).map((s) => s.meta),
        hoje,
      );
      // Avanço atual oficial: o do status (o filtroAPP unificou o cálculo com o Acompanhamento em 04/11/2026).
      // As semanas só dizem quanto andou; o fim da semana não substitui o avanço atual.
      const avanco = m.progressPercent;
      // O histórico do Omni guarda o avanço do status: não se mistura com o do Acompanhamento.
      const historico7 = sa ? null : (semanaPassada.get(m.id) ?? null);
      const sp = semPassada.get(m.id);
      const cu = custoM.get(m.id);
      const rom = romM.get(m.id);
      const pt = pontoPassado.get(m.id) ?? pontoAtual.get(m.id);
      const dados: MissaoRevisao = {
        stage: m.stage,
        fimEmCampo: m.fieldCompletionDate,
        usaRdo: Boolean(r),
        ultimoRdo: r?.ultimo ?? null,
        rdosDevolvidos: devM.get(m.id)?.n ?? 0,
        qualidade: { abertos: q?.abertos ?? 0, altoImpacto: q?.alto ?? 0, acaoVencida: q?.vencida ?? 0 },
        medicao: medicao ? { situacao: medicao.situacao, enviadaEm: medicao.enviadaEm, saldoPendente: med!.saldo } : null,
        notasAtrasadas: notaM.get(m.id)?.atrasadas ?? 0,
        perguntasSemResposta: c?.perguntas_sem_resposta ?? 0,
        tarefasAtrasadas: c?.tarefas_atrasadas ?? 0,
        avanco,
        avancoSemanaPassada: historico7,
        semanaPassada: sp ? { avancoInicio: sp.avancoInicio, avancoFim: sp.avancoFim, meta: sp.metaPontos } : null,
        metaFechada: metas.ultimaFechada,
        custo: cu ? { consumo: cu.consumo_do_custo, avanco: num(cu.avanco_fisico) } : null,
        equipamento: rom?.saida
          ? {
              saida: cal.dateKeyOf(new Date(rom.saida)),
              retornou: Boolean(rom.retorno && new Date(rom.retorno) >= new Date(rom.saida)),
              permanenciaPrevista: condM.get(m.id)?.dias ?? null,
              diaria: num(cu?.diaria_stand_by),
            }
          : null,
      };
      return {
        id: m.id,
        codigo: m.code,
        titulo: tituloMissao(m.code, m.clientName),
        etapa: etapaResumo(m.stage),
        minha: minhasSet.has(m.id),
        avanco,
        // Nesta semana pelo filtroAPP; sem ele, pelo histórico do Omni (7 dias).
        avancoSemana:
          sa?.avancoInicio != null && sa.avancoFim != null
            ? sa.avancoFim - sa.avancoInicio
            : avanco !== null && historico7 !== null
              ? avanco - historico7
              : null,
        semana:
          sa || metas.atual
            ? {
                meta: metas.atual
                  ? { texto: resumoMeta(metas.atual), situacao: metas.atual.situacao, rotulo: metas.atual.rotuloSituacao, periodo: periodoMeta(metas.atual) }
                  : sa?.metaPontos != null
                    ? { texto: `${sa.metaPontos.toLocaleString("pt-BR")} p.p.`, situacao: "", rotulo: "meta em pontos percentuais", periodo: "" }
                    : null,
                revisao: sa?.revisaoConcluidaEm ? "feita" : sa?.revisaoPendencias != null ? "pendente" : null,
              }
            : null,
        custo:
          cu && cu.custo_total !== null
            ? {
                consumo: cu.consumo_do_custo,
                avancoFisico: num(cu.avanco_fisico),
                realizado: Number(cu.custo_total),
                previsto: num(cu.custo_previsto),
                ate: cu.custo_ate!,
              }
            : null,
        equipe: {
          alocados: aloM.get(m.id)?.n ?? 0,
          ponto: pt ? { semanaPassada: pt.weekStart === passada, extrasMin: pt.minutosExtra70 + pt.minutosExtra100, pessoas: pt.pessoas } : null,
        },
        rdos: { semana: r?.semana ?? 0, devolvidos: dados.rdosDevolvidos, ultimo: r?.ultimo ?? null },
        qualidade: dados.qualidade,
        medicao,
        notas: { total: notaM.get(m.id)?.total ?? 0, atrasadas: dados.notasAtrasadas, emAberto: notaM.get(m.id)?.emAberto ?? 0 },
        pendencias: pendM.has(m.id) ? { aPagar: pendM.get(m.id)!.aPagar, aReceber: pendM.get(m.id)!.aReceber } : null,
        perguntasSemResposta: dados.perguntasSemResposta,
        tarefas: { abertas: c?.tarefas_abertas ?? 0, atrasadas: dados.tarefasAtrasadas },
        financeiro: f ? { aPagar: num(f.a_pagar), aReceber: num(f.a_receber), notasEmAberto: num(f.notas_em_aberto) } : null,
        alertas: alertasDaMissao(dados, cal, hoje),
      };
    });

    // Mais alertas graves primeiro; depois por código.
    const peso = (l: LinhaRevisao) => l.alertas.filter((a) => a.gravidade === "alta").length * 10 + l.alertas.length;
    linhas.sort((a, b) => peso(b) - peso(a) || a.codigo.localeCompare(b.codigo));
    return { semana: { inicio, fim }, geradaEm: new Date().toISOString(), linhas };
  });
});
