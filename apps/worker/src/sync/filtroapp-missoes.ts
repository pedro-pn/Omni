import { schema, type Db } from "@omni/db";
import { FiltroAppError, type FiltroAppClient, type Projeto, type Responsavel, type StatusColecao } from "@omni/integrations/filtroapp";
import { and, eq, notInArray, sql } from "drizzle-orm";

/**
 * Sincroniza as missões a partir do filtroAPP (Fase 2).
 *
 * 1. Projetos: incremental por `updatedSince` (com 5 min de sobreposição) e,
 *    uma vez por dia, completo — o que sumiu do filtroAPP vira inativo (a API
 *    de projetos não tem tombstone; ver docs/API_INTEGRACOES.md do filtroAPP).
 * 2. Status do workflow das missões ativas: uma leitura da coleção
 *    `/efetivo/projetos/status`. Missão ativa fora da coleção = sem workflow.
 * 3. Responsáveis (líder de projetos, gestor de contrato, líder de campo):
 *    leitura completa a cada execução; papel que sumiu é apagado.
 * Cada execução fica em `sync_runs`; o ponto de retomada em `sync_state`.
 */

export const FONTE = "filtroapp";
export const RECURSO = "missoes";
const COMPLETA_A_CADA_MS = 24 * 3600 * 1000;
const SOBREPOSICAO_MS = 5 * 60 * 1000;

export type FonteMissoes = Pick<FiltroAppClient, "listProjetos" | "listStatus" | "listResponsaveis"> & Partial<Pick<FiltroAppClient, "listColaboradores">>;

export type ResultadoSync = {
  completa: boolean;
  projetos: number;
  status: number;
  responsaveis: number;
  inativados: number;
};

function colunasProjeto(p: Projeto, agora: Date) {
  return {
    code: p.code,
    clientName: p.name.trim(),
    clientLegalName: p.clientName.trim() || null,
    clientCnpj: p.clientCnpj,
    commercialProposalCode: p.commercialProposalCode,
    // Vínculo oficial com o Prisma; campo ausente (versão antiga) não apaga o que já há.
    ...(p.prisma === undefined ? {} : { prismaMissionId: p.prisma?.missionId ?? null, prismaNumberScope: p.prisma?.numberScope ?? null }),
    location: p.location,
    clientSegment: p.clientSegment,
    isActive: p.isActive,
    mobilizationAt: p.mobilizationDate ? new Date(p.mobilizationDate) : null,
    demobilizationAt: p.demobilizationDate ? new Date(p.demobilizationDate) : null,
    startedAt: p.startDate ? new Date(p.startDate) : null,
    endDate: p.endDate ? p.endDate.slice(0, 10) : null,
    includesSaturday: p.includesSaturday,
    includesSunday: p.includesSunday,
    workdayHours: p.workdayHours,
    weekendWorkdayHours: p.weekendWorkdayHours,
    executedAtHeadquarters: p.executedAtHeadquarters,
    filtroappUpdatedAt: new Date(p.updatedAt),
    projectSyncedAt: agora,
  };
}

function colunasStatus(s: StatusColecao | null, agora: Date) {
  return {
    workflowStarted: s?.workflowStarted ?? null,
    stage: s?.workflowStarted ? s.stage : null,
    workflowVersion: s?.workflowVersion ?? null,
    plannedMobilizationDate: s?.plannedMobilizationDate ?? null,
    plannedExecutionStartDate: s?.plannedExecutionStartDate ?? null,
    plannedExecutionEndDate: s?.plannedExecutionEndDate ?? null,
    fieldCompletionDate: s?.fieldCompletionDate ?? null,
    demobilizationDate: s?.demobilizationDate ?? null,
    commercialReadiness: s?.commercialReadiness ?? null,
    mobilizationReady: s?.mobilizationReady ?? null,
    closureReady: s?.closureReady ?? null,
    openIssueCount: s?.openIssueCount ?? null,
    criticalIssueCount: s?.criticalIssueCount ?? null,
    progressPercent: s?.progressPercent ?? null,
    progressMethod: s?.progressMethod ?? null,
    closedAt: s?.closedAt ? new Date(s.closedAt) : null,
    commercialExpectedMobilizationDate: s?.commercialExpectedMobilizationDate ?? null,
    commercialExpectedStartDate: s?.commercialExpectedStartDate ?? null,
    commercialExpectedDurationDays: s?.commercialExpectedDurationDays ?? null,
    actualMobilizationDate: s?.actualMobilizationDate ?? null,
    statusSyncedAt: agora,
  };
}

/**
 * Liga o colaborador do filtroAPP à conta do Omni pelo e-mail dos responsáveis
 * (0045): com isso, a alocação no Efetivo dá acesso à missão. Só preenche quem
 * ainda não tem colaborador, e nunca o mesmo colaborador em duas contas.
 */
/** Liga pelo e-mail corporativo vindo de /colaboradores (só quem ainda não tem colaborador). */
export async function ligarPorEmailCorporativo(db: Db, colaboradores: Array<{ id: string; emailCorporativo?: string | null }>): Promise<number> {
  const pares = colaboradores.filter((c) => c.emailCorporativo && /@filtrovali\.com\.br$/i.test(c.emailCorporativo));
  if (!pares.length) return 0;
  const r = await db.execute(sql`
    UPDATE people p SET filtroapp_collaborator_id = c.colaborador
      FROM (SELECT DISTINCT ON (lower(x.email)) lower(x.email) AS email, x.colaborador
              FROM jsonb_to_recordset(${JSON.stringify(pares.map((c) => ({ email: c.emailCorporativo, colaborador: c.id })))}::jsonb) AS x(email text, colaborador text)
             ORDER BY lower(x.email), x.colaborador) c
     WHERE lower(p.email) = c.email AND p.filtroapp_collaborator_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM people y WHERE y.filtroapp_collaborator_id = c.colaborador)`);
  return r.rowCount ?? 0;
}

export async function ligarColaboradores(db: Db): Promise<number> {
  const r = await db.execute(sql`
    UPDATE people p SET filtroapp_collaborator_id = r.colaborador
      FROM (SELECT lower(email) AS email, min(filtroapp_collaborator_id) AS colaborador
              FROM mission_responsibles
             WHERE email IS NOT NULL AND filtroapp_collaborator_id IS NOT NULL
             GROUP BY lower(email)
            HAVING count(DISTINCT filtroapp_collaborator_id) = 1) r
     WHERE lower(p.email) = r.email AND p.filtroapp_collaborator_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM people x WHERE x.filtroapp_collaborator_id = r.colaborador)`);
  return r.rowCount ?? 0;
}

async function gravarResponsaveis(db: Db, responsaveis: Responsavel[], agora: Date): Promise<number> {
  const missoes = await db
    .select({ id: schema.missions.id, projectId: schema.missions.filtroappProjectId })
    .from(schema.missions);
  const porProjeto = new Map(missoes.map((m) => [m.projectId, m.id]));

  const vistos: Array<{ missionId: string; role: Responsavel["role"] }> = [];
  for (const r of responsaveis) {
    const missionId = porProjeto.get(r.projectId);
    if (!missionId) continue;
    const valores = {
      filtroappUserId: r.userId,
      filtroappCollaboratorId: r.collaboratorId,
      name: r.name.trim(),
      email: r.email?.trim().toLowerCase() || null,
      filtroappUpdatedAt: new Date(r.updatedAt),
      syncedAt: agora,
    };
    await db
      .insert(schema.missionResponsibles)
      .values({ missionId, role: r.role, ...valores })
      .onConflictDoUpdate({ target: [schema.missionResponsibles.missionId, schema.missionResponsibles.role], set: valores });
    vistos.push({ missionId, role: r.role });
  }

  // Papel que não veio mais (ex.: gestor de contrato desmarcado) sai do Omni.
  const chaves = vistos.map((v) => `${v.missionId}:${v.role}`);
  await db
    .delete(schema.missionResponsibles)
    .where(
      chaves.length
        ? sql`(${schema.missionResponsibles.missionId}::text || ':' || ${schema.missionResponsibles.role}) NOT IN (${sql.join(
            chaves.map((c) => sql`${c}`),
            sql`, `,
          )})`
        : sql`true`,
    );
  return vistos.length;
}

export async function syncMissoes(db: Db, fonte: FonteMissoes, now: () => Date = () => new Date()): Promise<ResultadoSync> {
  const [run] = await db
    .insert(schema.syncRuns)
    .values({ source: FONTE, resource: RECURSO })
    .returning({ id: schema.syncRuns.id });

  try {
    const inicio = now();
    const [estado] = await db
      .select()
      .from(schema.syncState)
      .where(and(eq(schema.syncState.source, FONTE), eq(schema.syncState.resource, RECURSO)));

    const completa =
      !estado?.watermark || !estado.lastFullAt || inicio.getTime() - estado.lastFullAt.getTime() >= COMPLETA_A_CADA_MS;
    const projetos = await fonte.listProjetos(
      completa ? {} : { updatedSince: new Date(estado!.watermark!.getTime() - SOBREPOSICAO_MS) },
    );

    let watermark = estado?.watermark ?? null;
    for (const projeto of projetos) {
      const valores = colunasProjeto(projeto, inicio);
      await db
        .insert(schema.missions)
        .values({ filtroappProjectId: projeto.id, ...valores })
        .onConflictDoUpdate({ target: schema.missions.filtroappProjectId, set: valores });
      const atualizado = new Date(projeto.updatedAt);
      if (!watermark || atualizado > watermark) watermark = atualizado;
    }

    let inativados = 0;
    if (completa && projetos.length > 0) {
      const sumidos = await db
        .update(schema.missions)
        .set({ isActive: false, projectSyncedAt: inicio })
        .where(
          and(
            eq(schema.missions.isActive, true),
            notInArray(
              schema.missions.filtroappProjectId,
              projetos.map((p) => p.id),
            ),
          ),
        )
        .returning({ id: schema.missions.id });
      inativados = sumidos.length;
    }

    // Status: uma leitura para todas as ativas.
    const status = await fonte.listStatus({ active: true });
    const statusPorProjeto = new Map(status.map((s) => [s.projectId, s]));
    const ativas = await db
      .select({ id: schema.missions.id, projectId: schema.missions.filtroappProjectId })
      .from(schema.missions)
      .where(eq(schema.missions.isActive, true));
    const agoraStatus = now();
    for (const missao of ativas) {
      await db
        .update(schema.missions)
        .set(colunasStatus(statusPorProjeto.get(missao.projectId) ?? null, agoraStatus))
        .where(eq(schema.missions.id, missao.id));
    }

    const responsaveis = await gravarResponsaveis(db, await fonte.listResponsaveis(), now());
    await ligarColaboradores(db);
    // E-mail corporativo do colaborador (spec 038): liga também quem só aparece alocado. Na carga completa (1×/dia).
    if (completa && fonte.listColaboradores) {
      try {
        await ligarPorEmailCorporativo(db, await fonte.listColaboradores());
      } catch (error) {
        // Sem o escopo colaboradores.contato_corporativo.read (403): segue só com os responsáveis.
        if (!(error instanceof FiltroAppError) || (error.status !== 403 && error.status !== 404)) throw error;
      }
    }

    const fim = now();
    await db
      .insert(schema.syncState)
      .values({ source: FONTE, resource: RECURSO, watermark, lastSuccessAt: fim, lastFullAt: completa ? fim : null })
      .onConflictDoUpdate({
        target: [schema.syncState.source, schema.syncState.resource],
        set: { watermark, lastSuccessAt: fim, ...(completa ? { lastFullAt: fim } : {}) },
      });
    await db
      .update(schema.syncRuns)
      .set({ status: "ok", finishedAt: fim, items: projetos.length + status.length + responsaveis })
      .where(eq(schema.syncRuns.id, run!.id));

    return { completa, projetos: projetos.length, status: status.length, responsaveis, inativados };
  } catch (error) {
    await db
      .update(schema.syncRuns)
      .set({ status: "erro", finishedAt: now(), error: String((error as Error).message).slice(0, 500) })
      .where(eq(schema.syncRuns.id, run!.id));
    throw error;
  }
}

