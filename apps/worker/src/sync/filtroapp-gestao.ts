import { schema, type Db } from "@omni/db";
import { addDays, segundaDaSemana, type BusinessCalendar } from "@omni/core";
import type { FiltroAppClient } from "@omni/integrations/filtroapp";
import { and, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";

/**
 * Gestão do filtroAPP (spec 034, B6), para a revisão semanal (migration 0018).
 *
 * - Semanas (avanço, meta e revisão; horas do ponto): o filtroAPP calcula na
 *   leitura, então o `updatedSince` repetiria tudo. Lemos sempre a janela das
 *   últimas SEMANAS semanas inteira e trocamos o que o Omni tem nela; uma vez
 *   por dia, as últimas SEMANAS_COMPLETA (a aba Gestão mostra a evolução).
 * - Custos × avanço: cálculo pesado no filtroAPP; lido uma vez por dia, completo.
 * Condições e alocações têm carimbo próprio e seguem o incremental da Entrega B.
 * Projeto que o Omni ainda não conhece é ignorado.
 */

export const SEMANAS = 4;
export const SEMANAS_COMPLETA = 12; // o máximo que o filtroAPP aceita
const COMPLETA_A_CADA_MS = 24 * 3600 * 1000;

export type FonteGestao = Pick<FiltroAppClient, "listSemanasAcompanhamento" | "listPontoSemanas" | "listCustos">;
export type FonteServicos = Pick<FiltroAppClient, "listServicos">;

const numero = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

async function missoesPorProjeto(db: Db) {
  const missoes = await db.select({ id: schema.missions.id, projectId: schema.missions.filtroappProjectId }).from(schema.missions);
  return { ids: missoes.map((m) => m.id), porProjeto: new Map(missoes.map((m) => [m.projectId, m.id])) };
}

async function marcar(db: Db, recurso: string, fim: Date, completa = true) {
  await db
    .insert(schema.syncState)
    .values({ source: "filtroapp", resource: recurso, watermark: fim, lastSuccessAt: fim, lastFullAt: completa ? fim : null })
    .onConflictDoUpdate({
      target: [schema.syncState.source, schema.syncState.resource],
      set: { watermark: fim, lastSuccessAt: fim, ...(completa ? { lastFullAt: fim } : {}) },
    });
}

/** Janela de semanas (segundas) que termina na semana de hoje, em São Paulo. */
export function janelaDeSemanas(cal: BusinessCalendar, agora: Date, semanas = SEMANAS): { from: string; to: string } {
  const to = segundaDaSemana(cal.dateKeyOf(agora));
  return { from: addDays(to, -7 * (semanas - 1)), to };
}

export async function syncSemanas(
  db: Db,
  fonte: FonteGestao,
  cal: BusinessCalendar,
  opcoes: { now?: () => Date } = {},
): Promise<{
  completa: boolean;
  semanas: { gravados: number; ignorados: number; removidos: number };
  ponto: { gravados: number; ignorados: number; removidos: number };
}> {
  const now = opcoes.now ?? (() => new Date());
  const inicio = now();
  const [estado] = await db
    .select({ lastFullAt: schema.syncState.lastFullAt })
    .from(schema.syncState)
    .where(and(eq(schema.syncState.source, "filtroapp"), eq(schema.syncState.resource, "semanas")));
  const completa = !estado?.lastFullAt || inicio.getTime() - estado.lastFullAt.getTime() >= COMPLETA_A_CADA_MS;
  const janela = janelaDeSemanas(cal, inicio, completa ? SEMANAS_COMPLETA : SEMANAS);
  const [semanas, ponto] = [await fonte.listSemanasAcompanhamento(janela), await fonte.listPontoSemanas(janela)];
  const { ids, porProjeto } = await missoesPorProjeto(db);

  const resultado = { completa, semanas: { gravados: 0, ignorados: 0, removidos: 0 }, ponto: { gravados: 0, ignorados: 0, removidos: 0 } };
  const vistosSemanas: string[] = [];
  for (const s of semanas) {
    const missionId = porProjeto.get(s.projectId);
    if (!missionId) {
      resultado.semanas.ignorados += 1;
      continue;
    }
    const v = {
      avancoInicio: s.avancoInicio,
      avancoFim: s.avancoFim,
      metaPontos: s.metaPontos,
      metaDefinidaPor: s.metaDefinidaPor,
      revisaoConcluidaEm: s.revisao?.concluidaEm ? new Date(s.revisao.concluidaEm) : null,
      revisaoPendencias: s.revisao?.pendencias ?? null,
      revisaoItens: s.revisao?.itens ?? null,
      meta: s.meta ?? null,
      filtroappUpdatedAt: new Date(s.updatedAt),
      syncedAt: inicio,
    };
    await db
      .insert(schema.missionWeeklyProgress)
      .values({ missionId, weekStart: s.weekStart, ...v })
      .onConflictDoUpdate({ target: [schema.missionWeeklyProgress.missionId, schema.missionWeeklyProgress.weekStart], set: v });
    vistosSemanas.push(`${missionId}|${s.weekStart}`);
    resultado.semanas.gravados += 1;
  }

  const vistosPonto: string[] = [];
  for (const p of ponto) {
    const missionId = porProjeto.get(p.projectId);
    if (!missionId) {
      resultado.ponto.ignorados += 1;
      continue;
    }
    const v = {
      minutosNormais: p.minutosNormais,
      minutosExtra70: p.minutosExtra70,
      minutosExtra100: p.minutosExtra100,
      minutosNoturnos: p.minutosNoturnos,
      pessoas: p.pessoas,
      filtroappUpdatedAt: new Date(p.atualizadoEm),
      syncedAt: inicio,
    };
    await db
      .insert(schema.missionTimesheetWeeks)
      .values({ missionId, weekStart: p.weekStart, ...v })
      .onConflictDoUpdate({ target: [schema.missionTimesheetWeeks.missionId, schema.missionTimesheetWeeks.weekStart], set: v });
    vistosPonto.push(`${missionId}|${p.weekStart}`);
    resultado.ponto.gravados += 1;
  }

  // Na janela, o que não veio sumiu (ex.: ponto de uma pessoa só passou a ser omitido).
  if (ids.length) {
    const fora = (tabela: typeof schema.missionWeeklyProgress | typeof schema.missionTimesheetWeeks, vistos: string[]) =>
      db
        .delete(tabela)
        .where(
          and(
            inArray(tabela.missionId, ids),
            gte(tabela.weekStart, janela.from),
            lte(tabela.weekStart, janela.to),
            vistos.length ? notInArray(sql`${tabela.missionId}::text || '|' || ${tabela.weekStart}::text`, vistos) : undefined,
          ),
        )
        .returning({ id: tabela.missionId });
    resultado.semanas.removidos = (await fora(schema.missionWeeklyProgress, vistosSemanas)).length;
    resultado.ponto.removidos = (await fora(schema.missionTimesheetWeeks, vistosPonto)).length;
  }
  await marcar(db, "semanas", now(), completa);
  return resultado;
}

export async function syncCustos(
  db: Db,
  fonte: FonteGestao,
  opcoes: { now?: () => Date } = {},
): Promise<{ gravados: number; ignorados: number; removidos: number }> {
  const now = opcoes.now ?? (() => new Date());
  const inicio = now();
  const custos = await fonte.listCustos();
  const { ids, porProjeto } = await missoesPorProjeto(db);
  const vistos: string[] = [];
  let ignorados = 0;
  for (const c of custos) {
    const missionId = porProjeto.get(c.projectId);
    if (!missionId) {
      ignorados += 1;
      continue;
    }
    const v = {
      precoVenda: numero(c.orcamento?.precoVenda),
      custoPrevisto: numero(c.orcamento?.custoPrevisto),
      margemPrevista: c.orcamento?.margemPrevista ?? null,
      diasPrevistos: c.orcamento?.diasPrevistos ?? null,
      custoTotal: Number(c.custoRealizado.total),
      custoPorCategoria: c.custoRealizado.porCategoria.map((x) => ({ codigo: x.codigo, rotulo: x.rotulo, valor: Number(x.valor) })),
      custoAte: c.custoRealizado.ate,
      avancoFisico: c.avancoFisico,
      consumoDoCusto: c.consumoDoCusto,
      filtroappUpdatedAt: new Date(c.atualizadoEm),
      syncedAt: inicio,
    };
    await db.insert(schema.missionCosts).values({ missionId, ...v }).onConflictDoUpdate({ target: schema.missionCosts.missionId, set: v });
    vistos.push(missionId);
  }
  const removidos = ids.length
    ? (
        await db
          .delete(schema.missionCosts)
          .where(and(inArray(schema.missionCosts.missionId, ids), vistos.length ? notInArray(schema.missionCosts.missionId, vistos) : undefined))
          .returning({ id: schema.missionCosts.missionId })
      ).length
    : 0;
  await marcar(db, "custos", now());
  return { gravados: vistos.length, ignorados, removidos };
}

/**
 * Composição do avanço por serviço (0074): leitura completa, substituindo a composição de
 * cada missão (o filtroAPP pede assim: o agregado não tem histórico). Missão que não veio
 * na leitura perde a composição.
 */
export async function syncServicos(
  db: Db,
  fonte: FonteServicos,
  opcoes: { now?: () => Date } = {},
): Promise<{ gravados: number; ignorados: number; removidos: number }> {
  const now = opcoes.now ?? (() => new Date());
  const inicio = now();
  const linhas = await fonte.listServicos();
  const { ids, porProjeto } = await missoesPorProjeto(db);
  const vistos: string[] = [];
  let ignorados = 0;
  for (const l of linhas) {
    const missionId = porProjeto.get(l.projectId);
    if (!missionId) {
      ignorados += 1;
      continue;
    }
    const v = { avancoTotal: l.avancoTotal, servicos: l.servicos, filtroappUpdatedAt: new Date(l.updatedAt), syncedAt: inicio };
    await db.insert(schema.missionServiceProgress).values({ missionId, ...v }).onConflictDoUpdate({ target: schema.missionServiceProgress.missionId, set: v });
    vistos.push(missionId);
  }
  const removidos = ids.length
    ? (
        await db
          .delete(schema.missionServiceProgress)
          .where(and(inArray(schema.missionServiceProgress.missionId, ids), vistos.length ? notInArray(schema.missionServiceProgress.missionId, vistos) : undefined))
          .returning({ id: schema.missionServiceProgress.missionId })
      ).length
    : 0;
  await marcar(db, "servicos", now());
  return { gravados: vistos.length, ignorados, removidos };
}

/** Eventos do feed que pedem reler as semanas (meta alterada, revisão concluída). */
export const pedeSemanas = (tipos: string[]) => tipos.some((t) => t.startsWith("acompanhamento."));
