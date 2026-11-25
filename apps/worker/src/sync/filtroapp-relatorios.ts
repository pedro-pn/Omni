import { schema, type Db } from "@omni/db";
import type { FiltroAppClient, Relatorio } from "@omni/integrations/filtroapp";
import { and, eq } from "drizzle-orm";

/**
 * Relatórios do filtroAPP (RDO e técnicos, todos os estados) para a IA e para a
 * missão. Incremental por `updatedSince` com 5 min de sobreposição; completo uma
 * vez por dia (≈ 1.800 relatórios em ~20 chamadas). Relatório de projeto que o
 * Omni ainda não conhece é ignorado (entra na próxima sincronização de missões).
 */

export const RECURSO_RELATORIOS = "relatorios";
const FONTE = "filtroapp";
const COMPLETA_A_CADA_MS = 24 * 3600 * 1000;
const SOBREPOSICAO_MS = 5 * 60 * 1000;

export type FonteRelatorios = Pick<FiltroAppClient, "listRelatorios">;

const minutos = (...v: Array<number | null>) => (v.every((x) => x === null) ? null : v.reduce<number>((s, x) => s + (x ?? 0), 0));

function colunas(r: Relatorio, missionId: string, agora: Date) {
  return {
    missionId,
    reportType: r.reportType,
    reportNumber: r.reportNumber,
    sequenceNumber: r.sequenceNumber,
    status: r.status,
    reportDate: r.reportDate.slice(0, 10),
    workedMinutes: minutos(r.daytimeWorkedMinutes, r.nighttimeWorkedMinutes),
    overtimeMinutes: r.totalOvertimeMinutes,
    dailyDescription: r.dailyDescription,
    overtimeReason: r.overtimeReason,
    submittedAt: r.submittedAt ? new Date(r.submittedAt) : null,
    approvedAt: r.approvedAt ? new Date(r.approvedAt) : null,
    returnedAt: r.returnedAt ? new Date(r.returnedAt) : null,
    signedAt: r.signedAt ? new Date(r.signedAt) : null,
    clientReleasedAt: r.clientReleasedAt ? new Date(r.clientReleasedAt) : null,
    filtroappUpdatedAt: new Date(r.updatedAt),
    syncedAt: agora,
    // Spec 038: sem o escopo do PDF o campo não vem (fica null = desconhecido).
    pdfDisponivel: r.pdf ? r.pdf.disponivel : null,
    pdfVersao: r.pdf?.versao ?? null,
    pdfNome: r.pdf?.nomeArquivo ?? null,
    pdfAtualizadoEm: r.pdf?.atualizadoEm ? new Date(r.pdf.atualizadoEm) : null,
    pdfAnexosManutencao: r.pdf?.maintenanceAttachmentIds ?? [],
  };
}

export async function syncRelatorios(
  db: Db,
  fonte: FonteRelatorios,
  opcoes: { forcarCompleta?: boolean; now?: () => Date } = {},
): Promise<{ completa: boolean; gravados: number; ignorados: number }> {
  const now = opcoes.now ?? (() => new Date());
  const inicio = now();
  const [estado] = await db
    .select()
    .from(schema.syncState)
    .where(and(eq(schema.syncState.source, FONTE), eq(schema.syncState.resource, RECURSO_RELATORIOS)));
  const completa =
    Boolean(opcoes.forcarCompleta) ||
    !estado?.watermark ||
    !estado.lastFullAt ||
    inicio.getTime() - estado.lastFullAt.getTime() >= COMPLETA_A_CADA_MS;

  const relatorios = await fonte.listRelatorios(
    completa ? {} : { updatedSince: new Date(estado!.watermark!.getTime() - SOBREPOSICAO_MS) },
  );

  const missoes = await db.select({ id: schema.missions.id, projectId: schema.missions.filtroappProjectId }).from(schema.missions);
  const porProjeto = new Map(missoes.map((m) => [m.projectId, m.id]));

  let watermark = estado?.watermark ?? null;
  let gravados = 0;
  let ignorados = 0;
  for (const r of relatorios) {
    const missionId = porProjeto.get(r.projectId);
    if (!missionId) {
      ignorados += 1;
      continue;
    }
    const valores = colunas(r, missionId, inicio);
    await db.insert(schema.reports).values({ id: r.id, ...valores }).onConflictDoUpdate({ target: schema.reports.id, set: valores });
    gravados += 1;
    const atualizado = new Date(r.updatedAt);
    if (!watermark || atualizado > watermark) watermark = atualizado;
  }

  const fim = now();
  await db
    .insert(schema.syncState)
    .values({ source: FONTE, resource: RECURSO_RELATORIOS, watermark, lastSuccessAt: fim, lastFullAt: completa ? fim : null })
    .onConflictDoUpdate({
      target: [schema.syncState.source, schema.syncState.resource],
      set: { watermark, lastSuccessAt: fim, ...(completa ? { lastFullAt: fim } : {}) },
    });
  return { completa, gravados, ignorados };
}
