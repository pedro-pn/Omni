import { addDays, diasCorridos, segundaDaSemana, type MetaFiltroApp } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Aba Gestão da missão (Fase 9): o que o filtroAPP sabe de avanço, custo,
 * equipe, horas e equipamentos (migrations 0016–0018). Avanço, equipe e horas
 * para gestão e quem vê o Interno (RLS); custos e diária só para gerente e
 * diretoria (app.custos_missoes).
 */

export type SemanaGestao = {
  inicio: string;
  avancoInicio: number | null;
  avancoFim: number | null;
  meta: number | null;
  /** Meta como cadastrada no filtroAPP (período próprio, unidades físicas). */
  metaFiltroApp: MetaFiltroApp | null;
  revisao: { concluidaEm: string | null; pendencias: number; itens: { codigo: string; rotulo: string; ok: boolean }[] } | null;
  /** Alocados no Efetivo na semana (equipe prevista). */
  alocados: number;
  ponto: { normais: number; extra70: number; extra100: number; noturnos: number; pessoas: number } | null;
  rdos: number;
};

export type GestaoMissao = {
  podeVer: boolean;
  veCustos: boolean;
  custo: {
    precoVenda: number | null;
    custoPrevisto: number | null;
    margemPrevista: number | null;
    diasPrevistos: number | null;
    total: number;
    porCategoria: { codigo: string; rotulo: string; valor: number }[];
    ate: string;
    avancoFisico: number | null;
    consumo: number | null;
  } | null;
  semanas: SemanaGestao[];
  equipe: { funcao: string; pessoas: number; mobilizacao: string | null; desmobilizacao: string | null }[];
  equipamento: {
    saida: string;
    retorno: string | null;
    permanenciaPrevista: number | null;
    diasEmObra: number | null;
    diaria: number | null;
  } | null;
  /** Medição, notas e pendências do Omie (do filtroAPP); valores em reais só para gestão. */
  faturamento: {
    medicao: { situacao: string; preparadaEm: string | null; enviadaEm: string | null; aprovadaEm: string | null; saldoPendente: boolean | null } | null;
    notas: { id: string; tipo: string; numero: string; emissao: string; recebimento: string }[];
    pendencias: { aPagar: number; aReceber: number; proximoVencimento: string | null } | null;
    valores: { executado: number | null; medido: number | null; aprovado: number | null; notasEmitidas: number | null; notasEmAberto: number | null; aPagar: number | null; aReceber: number | null } | null;
  };
  /** Composição do avanço por serviço e equipamento, como no detalhe do projeto no filtroAPP. */
  composicao: {
    avancoTotal: number | null;
    servicos: {
      escopo: string | null;
      servico: string;
      rotuloServico: string;
      equipamento: string | null;
      avancoPct: number | null;
      unidade: string | null;
      rotuloUnidade: string | null;
      previsto: number | null;
      realizado: number | null;
      sistemas: number;
    }[];
    atualizadoEm: string;
  } | null;
  /** Registros de Qualidade da missão (sem descrição nem responsável, como sincronizados). */
  desvios: { id: string; numero: string; tipo: string; status: string; aberto: boolean; impacto: string | null; data: string | null; natureza: string | null; prazo: string | null; recorrente: boolean | null }[];
  atualizadoEm: string | null;
};

/** Situações de Qualidade ainda abertas (mesma lista da revisão semanal). */
const QUALIDADE_ABERTA = ["ABERTO", "EM_ACAO", "EM_OBSERVACAO"];

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const hojeSaoPaulo = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const diaSP = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
/** Semanas mostradas na aba (a mais nova é a atual). */
export const SEMANAS_NA_ABA = 12;

export const getGestaoMissao = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<GestaoMissao> => {
    const personId = await personIdFromRequest(getRequest());
    if (!personId) throw new ErroParaTela("Sessão expirada. Entre de novo.");
    const hoje = hojeSaoPaulo();
    const atual = segundaDaSemana(hoje);
    const primeira = addDays(atual, -7 * (SEMANAS_NA_ABA - 1));

    return withPerson(getPool(), personId, async (db) => {
      const [acesso] = (
        await db.execute<{ gestao: boolean; interno: boolean }>(
          sql`SELECT app.ve_gestao() AS gestao, app.canal_desde(${data.missionId}::uuid, 'interno') IS NOT NULL AS interno`,
        )
      ).rows;
      const vazio: GestaoMissao = {
        podeVer: false,
        veCustos: false,
        custo: null,
        semanas: [],
        equipe: [],
        equipamento: null,
        faturamento: { medicao: null, notas: [], pendencias: null, valores: null },
        composicao: null,
        desvios: [],
        atualizadoEm: null,
      };
      if (!acesso || (!acesso.gestao && !acesso.interno)) return vazio;

      const m = data.missionId;
      const [missao] = await db
        .select({
          inicio: sql<string | null>`coalesce(${schema.missions.actualMobilizationDate}, ${schema.missions.plannedMobilizationDate})::text`,
          fim: sql<string | null>`${schema.missions.demobilizationDate}::text`,
        })
        .from(schema.missions)
        .where(eq(schema.missions.id, m));
      const [semanas, ponto, alocacoes, rdos, [cond], [rom], custos] = await Promise.all([
        db
          .select()
          .from(schema.missionWeeklyProgress)
          .where(and(eq(schema.missionWeeklyProgress.missionId, m), sql`${schema.missionWeeklyProgress.weekStart} >= ${primeira}`)),
        db
          .select()
          .from(schema.missionTimesheetWeeks)
          .where(and(eq(schema.missionTimesheetWeeks.missionId, m), sql`${schema.missionTimesheetWeeks.weekStart} >= ${primeira}`)),
        db
          .select({
            colaborador: schema.missionAllocations.collaboratorId,
            funcao: schema.missionAllocations.funcao,
            mobilizacao: schema.missionAllocations.mobilizacao,
            desmobilizacao: schema.missionAllocations.desmobilizacao,
          })
          .from(schema.missionAllocations)
          .where(and(eq(schema.missionAllocations.missionId, m), isNull(schema.missionAllocations.deletedAt))),
        db
          .select({ semana: sql<string>`date_trunc('week', ${schema.reports.reportDate})::date::text`, n: sql<number>`count(*)::int` })
          .from(schema.reports)
          .where(and(eq(schema.reports.missionId, m), sql`${schema.reports.reportType} LIKE 'RDO%'`, sql`${schema.reports.reportDate} >= ${primeira}`))
          .groupBy(sql`1`),
        db
          .select({ dias: schema.missionConditions.permanenciaPrevistaDias, em: schema.missionConditions.syncedAt })
          .from(schema.missionConditions)
          .where(eq(schema.missionConditions.missionId, m)),
        db
          .select({
            saida: sql<Date | null>`min(${schema.missionRomaneios.data}) FILTER (WHERE ${schema.missionRomaneios.tipo} = 'SAIDA')`,
            retorno: sql<Date | null>`max(${schema.missionRomaneios.data}) FILTER (WHERE ${schema.missionRomaneios.tipo} = 'RETORNO')`,
          })
          .from(schema.missionRomaneios)
          .where(eq(schema.missionRomaneios.missionId, m)),
        db.execute<{
          preco_venda: string | null;
          custo_previsto: string | null;
          margem_prevista: string | null;
          dias_previstos: string | null;
          custo_total: string | null;
          custo_por_categoria: { codigo: string; rotulo: string; valor: number }[] | null;
          custo_ate: string | null;
          avanco_fisico: string | null;
          consumo_do_custo: number | null;
          diaria_stand_by: string | null;
        }>(sql`SELECT preco_venda, custo_previsto, margem_prevista, dias_previstos, custo_total, custo_por_categoria, custo_ate::text,
                      avanco_fisico, consumo_do_custo, diaria_stand_by
                 FROM app.custos_missoes() WHERE mission_id = ${m}`),
      ]);

      // Faturamento e desvios (Entrega B e Qualidade do filtroAPP).
      const [[med], notas, [pend], qualidade, financeiro, [comp]] = await Promise.all([
        db
          .select({
            situacao: schema.missionMeasurements.situacao,
            preparedAt: schema.missionMeasurements.preparedAt,
            sentAt: schema.missionMeasurements.sentAt,
            approvedAt: schema.missionMeasurements.approvedAt,
            saldoPendente: schema.missionMeasurements.saldoPendente,
          })
          .from(schema.missionMeasurements)
          .where(eq(schema.missionMeasurements.missionId, m)),
        db
          .select({ id: schema.missionInvoices.id, tipo: schema.missionInvoices.tipo, numero: schema.missionInvoices.numero, emissao: schema.missionInvoices.dataEmissao, recebimento: schema.missionInvoices.situacaoRecebimento })
          .from(schema.missionInvoices)
          .where(eq(schema.missionInvoices.missionId, m))
          .orderBy(sql`${schema.missionInvoices.dataEmissao} DESC`)
          .limit(30),
        db
          .select({ aPagar: schema.missionPending.aPagarQtd, aReceber: schema.missionPending.aReceberQtd, vencPagar: schema.missionPending.aPagarVencimento, vencReceber: schema.missionPending.aReceberVencimento })
          .from(schema.missionPending)
          .where(eq(schema.missionPending.missionId, m)),
        db
          .select()
          .from(schema.missionQualityRecords)
          .where(and(eq(schema.missionQualityRecords.missionId, m), isNull(schema.missionQualityRecords.deletedAt)))
          .orderBy(sql`${schema.missionQualityRecords.eventDate} DESC NULLS LAST`)
          .limit(50),
        acesso.gestao
          ? db.execute<{
              medicao_executada: string | null;
              medicao_medida: string | null;
              medicao_aprovada: string | null;
              notas_emitidas: string | null;
              notas_em_aberto: string | null;
              a_pagar: string | null;
              a_receber: string | null;
            }>(sql`SELECT medicao_executada, medicao_medida, medicao_aprovada, notas_emitidas, notas_em_aberto, a_pagar, a_receber FROM app.financeiro_missoes() WHERE mission_id = ${m}`)
          : Promise.resolve(null),
        db.select().from(schema.missionServiceProgress).where(eq(schema.missionServiceProgress.missionId, m)),
      ]);
      const fin = financeiro?.rows[0];
      const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
      const proximoVenc = [pend?.vencPagar, pend?.vencReceber].filter((d): d is Date => Boolean(d)).sort((a, b) => a.getTime() - b.getTime())[0];

      const c = custos.rows[0];
      const rdoPor = new Map(rdos.map((r) => [r.semana, r.n]));
      const semPor = new Map(semanas.map((s) => [s.weekStart, s]));
      const pontoPor = new Map(ponto.map((p) => [p.weekStart, p]));
      const lista: SemanaGestao[] = [];
      for (let inicio = primeira; inicio <= atual; inicio = addDays(inicio, 7)) {
        const fim = addDays(inicio, 6);
        const s = semPor.get(inicio);
        const p = pontoPor.get(inicio);
        // Alocação sem datas no Efetivo vale pelo período da missão.
        const alocados = new Set(
          alocacoes
            .filter((a) => {
              const de = a.mobilizacao ?? missao?.inicio ?? null;
              const ate = a.desmobilizacao ?? missao?.fim ?? null;
              return de !== null && de <= fim && (!ate || ate >= inicio);
            })
            .map((a) => a.colaborador),
        ).size;
        lista.push({
          inicio,
          avancoInicio: s?.avancoInicio ?? null,
          avancoFim: s?.avancoFim ?? null,
          meta: s?.metaPontos ?? null,
          metaFiltroApp: s?.meta ?? null,
          revisao: s?.revisaoItens
            ? { concluidaEm: s.revisaoConcluidaEm?.toISOString() ?? null, pendencias: s.revisaoPendencias ?? 0, itens: s.revisaoItens }
            : null,
          alocados,
          ponto: p
            ? { normais: p.minutosNormais, extra70: p.minutosExtra70, extra100: p.minutosExtra100, noturnos: p.minutosNoturnos, pessoas: p.pessoas }
            : null,
          rdos: rdoPor.get(inicio) ?? 0,
        });
      }
      // Some semanas iniciais sem nenhum dado (missão mais nova que a janela).
      while (lista.length > 1 && !lista[0]!.avancoFim && !lista[0]!.ponto && !lista[0]!.alocados && !lista[0]!.rdos) lista.shift();

      // Equipe atual (ou a última prevista), agrupada por função.
      const vigentes = alocacoes.filter((a) => !a.desmobilizacao || a.desmobilizacao >= hoje);
      const base = vigentes.length ? vigentes : alocacoes;
      const porFuncao = new Map<string, { funcao: string; pessoas: Set<string>; mobilizacao: string | null; desmobilizacao: string | null }>();
      for (const a of base) {
        const f = a.funcao ?? "Sem função";
        const g = porFuncao.get(f) ?? { funcao: f, pessoas: new Set<string>(), mobilizacao: null, desmobilizacao: null };
        g.pessoas.add(a.colaborador);
        if (a.mobilizacao && (!g.mobilizacao || a.mobilizacao < g.mobilizacao)) g.mobilizacao = a.mobilizacao;
        if (a.desmobilizacao && (!g.desmobilizacao || a.desmobilizacao > g.desmobilizacao)) g.desmobilizacao = a.desmobilizacao;
        porFuncao.set(f, g);
      }

      const saida = rom?.saida ? diaSP(new Date(rom.saida)) : null;
      const retorno = rom?.retorno && rom.saida && new Date(rom.retorno) >= new Date(rom.saida) ? diaSP(new Date(rom.retorno)) : null;
      const ultimaSync = [...semanas.map((s) => s.syncedAt), ...(cond ? [cond.em] : [])].sort((a, b) => b.getTime() - a.getTime())[0];

      return {
        podeVer: true,
        veCustos: acesso.gestao,
        custo:
          c && c.custo_total !== null
            ? {
                precoVenda: num(c.preco_venda),
                custoPrevisto: num(c.custo_previsto),
                margemPrevista: num(c.margem_prevista),
                diasPrevistos: num(c.dias_previstos),
                total: Number(c.custo_total),
                porCategoria: c.custo_por_categoria ?? [],
                ate: c.custo_ate!,
                avancoFisico: num(c.avanco_fisico),
                consumo: c.consumo_do_custo,
              }
            : null,
        semanas: lista,
        equipe: [...porFuncao.values()]
          .map((g) => ({ funcao: g.funcao, pessoas: g.pessoas.size, mobilizacao: g.mobilizacao, desmobilizacao: g.desmobilizacao }))
          .sort((a, b) => b.pessoas - a.pessoas || a.funcao.localeCompare(b.funcao)),
        equipamento: saida
          ? {
              saida,
              retorno,
              permanenciaPrevista: cond?.dias ?? null,
              diasEmObra: retorno ? diasCorridos(saida, retorno) : diasCorridos(saida, hoje),
              diaria: c ? num(c.diaria_stand_by) : null,
            }
          : null,
        faturamento: {
          medicao: med ? { situacao: med.situacao, preparadaEm: iso(med.preparedAt), enviadaEm: iso(med.sentAt), aprovadaEm: iso(med.approvedAt), saldoPendente: med.saldoPendente } : null,
          notas: notas.map((n) => ({ ...n, emissao: n.emissao.toISOString() })),
          pendencias: pend ? { aPagar: pend.aPagar, aReceber: pend.aReceber, proximoVencimento: iso(proximoVenc) } : null,
          valores: fin
            ? {
                executado: num(fin.medicao_executada),
                medido: num(fin.medicao_medida),
                aprovado: num(fin.medicao_aprovada),
                notasEmitidas: num(fin.notas_emitidas),
                notasEmAberto: num(fin.notas_em_aberto),
                aPagar: num(fin.a_pagar),
                aReceber: num(fin.a_receber),
              }
            : null,
        },
        composicao: comp ? { avancoTotal: comp.avancoTotal, servicos: comp.servicos, atualizadoEm: comp.filtroappUpdatedAt.toISOString() } : null,
        desvios: qualidade
          .map((q) => ({
            id: q.id,
            numero: q.number,
            tipo: q.type,
            status: q.status,
            aberto: QUALIDADE_ABERTA.includes(q.status),
            impacto: q.impact,
            data: q.eventDate,
            natureza: q.nature,
            prazo: q.actionDeadline,
            recorrente: q.recurrent,
          }))
          .sort((a, b) => Number(b.aberto) - Number(a.aberto)),
        atualizadoEm: ultimaSync?.toISOString() ?? null,
      };
    });
  });
