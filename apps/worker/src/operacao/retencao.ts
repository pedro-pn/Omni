import { schema, type Db } from "@omni/db";
import type { GraphClient } from "@omni/integrations/graph";
import { asc, eq, lt, sql } from "drizzle-orm";

/**
 * Retenção (job `retencao`, 03:40; prazos em app.aplicar_retencao, migrations 0066 e 0081).
 *
 * 1. `app.aplicar_retencao`: com RETENCAO=ensaio só conta; com `real` apaga o vencido e põe os
 *    arquivos do SharePoint (canais e anexos de tarefas) em `arquivos_para_apagar`.
 * 2. Com `real`, apaga de vez esses arquivos no SharePoint (404 conta como apagado). O que falhar
 *    fica na fila e tenta de novo na próxima noite; depois de 5 tentativas, para e vira erro do
 *    sistema pelo próprio job (a fila não some sem alguém ver).
 */
const POR_RODADA = 500;
export const MAX_TENTATIVAS = 5;

export async function aplicarRetencao(
  db: Db,
  modo: "ensaio" | "real",
  sharepoint: Pick<GraphClient, "apagarDefinitivo"> | null,
): Promise<Record<string, unknown>> {
  const r = (await db.execute<{ r: Record<string, unknown> }>(sql`SELECT app.aplicar_retencao(${modo === "real"}) AS r`)).rows[0]?.r ?? {};
  if (modo !== "real") return r;
  const arquivos = await apagarArquivos(db, sharepoint);
  if (arquivos.desistidos > 0) {
    throw new Error(`Retenção: ${arquivos.desistidos} arquivo(s) do SharePoint não foram apagados depois de ${MAX_TENTATIVAS} tentativas.`);
  }
  return { ...r, arquivos };
}

async function apagarArquivos(db: Db, sharepoint: Pick<GraphClient, "apagarDefinitivo"> | null) {
  const f = schema.arquivosParaApagar;
  const res = { apagados: 0, erros: 0, desistidos: 0, semGraph: false };
  const fila = await db.select().from(f).where(lt(f.tentativas, MAX_TENTATIVAS)).orderBy(asc(f.id)).limit(POR_RODADA);
  if (fila.length && !sharepoint) {
    res.semGraph = true;
    return res;
  }
  for (const a of fila) {
    try {
      await sharepoint!.apagarDefinitivo(a.spDriveId, a.spItemId);
      await db.delete(f).where(eq(f.id, a.id));
      res.apagados += 1;
    } catch (erro) {
      res.erros += 1;
      await db
        .update(f)
        .set({ tentativas: a.tentativas + 1, ultimoErro: String((erro as Error).message ?? erro).slice(0, 300) })
        .where(eq(f.id, a.id));
    }
  }
  res.desistidos = (await db.select({ n: sql<number>`count(*)::int` }).from(f).where(sql`${f.tentativas} >= ${MAX_TENTATIVAS}`))[0]?.n ?? 0;
  return res;
}
