import { schema, type Db } from "@omni/db";
import { FiltroAppError, type FiltroAppClient } from "@omni/integrations/filtroapp";
import { and, eq } from "drizzle-orm";

import { recursosDosEventos, type RecursoEntregaB } from "./filtroapp-entrega-b.ts";
import { pedeSemanas } from "./filtroapp-gestao.ts";

/**
 * Feed de eventos do filtroAPP (spec 034). Lê a partir do cursor salvo e
 * dispara só o que mudou: RDOs → sincronização de relatórios; etapa ou
 * responsáveis → sincronização de missões; medição, notas, romaneios,
 * pendências, descargas e alocações → só o recurso correspondente; meta ou
 * revisão semanal → releitura das semanas (Gestão, B6). Cursor vencido (410 CURSOR_EXPIRED)
 * → conferência completa e recomeço do feed. Entrega "pelo menos uma vez":
 * as sincronizações são idempotentes, então repetir um evento não faz mal.
 */

export const RECURSO_EVENTOS = "eventos";
const FONTE = "filtroapp";

export type FonteEventos = Pick<FiltroAppClient, "listEventos">;
export type AcoesEventos = {
  missoes: () => Promise<unknown>;
  relatorios: (opcoes?: { forcarCompleta?: boolean }) => Promise<unknown>;
  entregaB?: (opcoes: { recursos?: RecursoEntregaB[]; forcarCompleta?: boolean }) => Promise<unknown>;
  semanas?: () => Promise<unknown>;
};

export type ResultadoEventos = { eventos: number; tipos: Record<string, number>; reiniciado: boolean };

async function salvarCursor(db: Db, cursor: string | null) {
  const agora = new Date();
  await db
    .insert(schema.syncState)
    .values({ source: FONTE, resource: RECURSO_EVENTOS, cursor, lastSuccessAt: agora })
    .onConflictDoUpdate({ target: [schema.syncState.source, schema.syncState.resource], set: { cursor, lastSuccessAt: agora } });
}

export async function processarEventos(db: Db, fonte: FonteEventos, acoes: AcoesEventos): Promise<ResultadoEventos> {
  const [estado] = await db
    .select()
    .from(schema.syncState)
    .where(and(eq(schema.syncState.source, FONTE), eq(schema.syncState.resource, RECURSO_EVENTOS)));

  let cursor = estado?.cursor ?? null;
  const tipos: Record<string, number> = {};
  let total = 0;

  try {
    for (;;) {
      const pagina = await fonte.listEventos(cursor);
      for (const e of pagina.itens) tipos[e.type] = (tipos[e.type] ?? 0) + 1;
      total += pagina.itens.length;
      cursor = pagina.nextCursor;
      if (!pagina.hasMore) break;
    }
  } catch (error) {
    if (error instanceof FiltroAppError && error.status === 410) {
      await acoes.missoes();
      await acoes.relatorios({ forcarCompleta: true });
      await acoes.entregaB?.({ forcarCompleta: true });
      await acoes.semanas?.();
      await salvarCursor(db, null);
      return { eventos: 0, tipos: {}, reiniciado: true };
    }
    throw error;
  }

  const houve = (prefixo: string) => Object.keys(tipos).some((t) => t.startsWith(prefixo));
  // Primeiro sincroniza; só depois guarda o cursor (se falhar, os eventos são relidos).
  if (houve("workflow.") || houve("projeto.")) await acoes.missoes();
  if (houve("rdo.")) await acoes.relatorios();
  const recursos = recursosDosEventos(Object.keys(tipos));
  if (recursos.length && acoes.entregaB) await acoes.entregaB({ recursos });
  if (pedeSemanas(Object.keys(tipos))) await acoes.semanas?.();
  await salvarCursor(db, cursor);
  return { eventos: total, tipos, reiniciado: false };
}
