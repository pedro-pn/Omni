import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";
import { exigirModulo } from "../server/modulos.ts";

export type MissaoResumo = {
  id: string;
  code: string;
  clientName: string;
  clientLegalName: string | null;
  clientCnpj: string | null;
  commercialProposalCode: string | null;
  location: string | null;
  clientSegment: string | null;
  includesSaturday: boolean | null;
  includesSunday: boolean | null;
  workdayHours: string | null;
  executedAtHeadquarters: boolean | null;
  stage: string | null;
  workflowStarted: boolean | null;
  progressPercent: number | null;
  openIssueCount: number | null;
  criticalIssueCount: number | null;
  /** Prontidão no filtroAPP (status do projeto): comercial liberado, mobilização e encerramento liberados. */
  commercialReadiness: string | null;
  mobilizationReady: boolean | null;
  closureReady: boolean | null;
  plannedMobilizationDate: string | null;
  commercialExpectedMobilizationDate: string | null;
  actualMobilizationDate: string | null;
  demobilizationDate: string | null;
  startedAt: string | null;
  closedAt: string | null;
  /** Ciclo encerrado no Omni (a IA deixou de acompanhar). */
  cicloEncerradoEm: string | null;
  statusSyncedAt: string | null;
};

export type ResponsavelMissao = {
  role: "LEADER" | "PLANNER" | "FIELD_OPERATOR";
  name: string;
  email: string | null;
  /** Pessoa do Omni com o mesmo e-mail (null = ainda não entrou no Omni). */
  personId: string | null;
};

async function exigirPessoa(): Promise<string> {
  const personId = await personIdFromRequest(getRequest());
  if (!personId) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return personId;
}

/**
 * Missões ativas, lidas pelo papel omni_app com RLS: quem não tem perfil recebe
 * lista vazia (a política decide, não este código).
 */
export const listMissoes = createServerFn({ method: "GET" }).handler(async (): Promise<MissaoResumo[]> => {
  const personId = await exigirPessoa();
  await exigirModulo(personId, "missoes");
  const rows = await withPerson(getPool(), personId, (db) =>
    db
      .select()
      .from(schema.missions)
      .where(eq(schema.missions.isActive, true))
      .orderBy(desc(schema.missions.code)),
  );
  return rows.map((m) => ({
    id: m.id,
    code: m.code,
    clientName: m.clientName,
    clientLegalName: m.clientLegalName,
    clientCnpj: m.clientCnpj,
    commercialProposalCode: m.commercialProposalCode,
    location: m.location,
    clientSegment: m.clientSegment,
    includesSaturday: m.includesSaturday,
    includesSunday: m.includesSunday,
    workdayHours: m.workdayHours,
    executedAtHeadquarters: m.executedAtHeadquarters,
    stage: m.stage,
    workflowStarted: m.workflowStarted,
    progressPercent: m.progressPercent,
    openIssueCount: m.openIssueCount,
    criticalIssueCount: m.criticalIssueCount,
    commercialReadiness: m.commercialReadiness,
    mobilizationReady: m.mobilizationReady,
    closureReady: m.closureReady,
    plannedMobilizationDate: m.plannedMobilizationDate,
    commercialExpectedMobilizationDate: m.commercialExpectedMobilizationDate,
    actualMobilizationDate: m.actualMobilizationDate,
    demobilizationDate: m.demobilizationDate,
    startedAt: m.startedAt?.toISOString() ?? null,
    closedAt: m.closedAt?.toISOString() ?? null,
    cicloEncerradoEm: m.cycleClosedAt?.toISOString() ?? null,
    statusSyncedAt: m.statusSyncedAt?.toISOString() ?? null,
  }));
});

const ORDEM_PAPEIS = { LEADER: 0, PLANNER: 1, FIELD_OPERATOR: 2 } as const;

/** Responsáveis de uma missão, ligados às pessoas do Omni pelo e-mail. */
export const listResponsaveis = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<ResponsavelMissao[]> => {
    const personId = await exigirPessoa();
    const rows = await withPerson(getPool(), personId, (db) =>
      db
        .select({
          role: schema.missionResponsibles.role,
          name: schema.missionResponsibles.name,
          email: schema.missionResponsibles.email,
          personId: schema.people.id,
        })
        .from(schema.missionResponsibles)
        .leftJoin(
          schema.people,
          sql`${schema.people.email} = ${schema.missionResponsibles.email} AND ${schema.people.active}`,
        )
        .where(eq(schema.missionResponsibles.missionId, data.missionId)),
    );
    return rows.sort((a, b) => ORDEM_PAPEIS[a.role] - ORDEM_PAPEIS[b.role]);
  });

export type PosCampo = {
  medicao: { situacao: "SEM_MEDICAO" | "PREPARADA" | "ENVIADA" | "APROVADA"; preparadaEm: string | null; enviadaEm: string | null; aprovadaEm: string | null; saldoPendente: boolean | null } | null;
  notas: Array<{ id: string; tipo: string; numero: string; emissao: string; recebimento: string }>;
  romaneios: Array<{ id: string; tipo: "SAIDA" | "RETORNO"; data: string; itens: number; descarga: { tipo: "PARCIAL" | "TOTAL"; em: string } | null }>;
  pendencias: { aPagar: number; aReceber: number; proximoVencimento: string | null } | null;
};

/**
 * O que o filtroAPP sabe da missão depois do campo (Entrega B): medição,
 * notas, romaneios com a descarga e pendências no Omie. Sem valores em reais:
 * a tela não tem acesso a essas colunas (GRANT por coluna, migration 0016).
 */
export const getPosCampo = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<PosCampo> => {
    const personId = await exigirPessoa();
    return withPerson(getPool(), personId, async (db) => {
      const [med] = await db
        .select({
          situacao: schema.missionMeasurements.situacao,
          preparedAt: schema.missionMeasurements.preparedAt,
          sentAt: schema.missionMeasurements.sentAt,
          approvedAt: schema.missionMeasurements.approvedAt,
          saldoPendente: schema.missionMeasurements.saldoPendente,
        })
        .from(schema.missionMeasurements)
        .where(eq(schema.missionMeasurements.missionId, data.missionId));
      const notas = await db
        .select({
          id: schema.missionInvoices.id,
          tipo: schema.missionInvoices.tipo,
          numero: schema.missionInvoices.numero,
          emissao: schema.missionInvoices.dataEmissao,
          recebimento: schema.missionInvoices.situacaoRecebimento,
        })
        .from(schema.missionInvoices)
        .where(eq(schema.missionInvoices.missionId, data.missionId))
        .orderBy(desc(schema.missionInvoices.dataEmissao))
        .limit(20);
      const romaneios = await db
        .select({ id: schema.missionRomaneios.id, tipo: schema.missionRomaneios.tipo, data: schema.missionRomaneios.data, itens: schema.missionRomaneios.quantidadeItens })
        .from(schema.missionRomaneios)
        .where(eq(schema.missionRomaneios.missionId, data.missionId))
        .orderBy(desc(schema.missionRomaneios.data))
        .limit(20);
      const descargas = await db
        .select({ romaneioId: schema.missionUnloadings.romaneioId, tipo: schema.missionUnloadings.tipo, em: schema.missionUnloadings.confirmadaEm })
        .from(schema.missionUnloadings)
        .where(eq(schema.missionUnloadings.missionId, data.missionId));
      const [pend] = await db
        .select({
          aPagar: schema.missionPending.aPagarQtd,
          aReceber: schema.missionPending.aReceberQtd,
          vencPagar: schema.missionPending.aPagarVencimento,
          vencReceber: schema.missionPending.aReceberVencimento,
        })
        .from(schema.missionPending)
        .where(eq(schema.missionPending.missionId, data.missionId));
      const iso = (d: Date | null) => d?.toISOString() ?? null;
      const proximo = [pend?.vencPagar, pend?.vencReceber].filter((d): d is Date => Boolean(d)).sort((a, b) => a.getTime() - b.getTime())[0];
      return {
        medicao: med
          ? { situacao: med.situacao, preparadaEm: iso(med.preparedAt), enviadaEm: iso(med.sentAt), aprovadaEm: iso(med.approvedAt), saldoPendente: med.saldoPendente }
          : null,
        notas: notas.map((n) => ({ ...n, emissao: n.emissao.toISOString() })),
        romaneios: romaneios.map((r) => {
          const desc_ = descargas.filter((d) => d.romaneioId === r.id).sort((a, b) => b.em.getTime() - a.em.getTime());
          const total = desc_.find((d) => d.tipo === "TOTAL") ?? desc_[0];
          return { id: r.id, tipo: r.tipo, data: r.data.toISOString(), itens: r.itens, descarga: total ? { tipo: total.tipo, em: total.em.toISOString() } : null };
        }),
        pendencias: pend ? { aPagar: pend.aPagar, aReceber: pend.aReceber, proximoVencimento: iso(proximo ?? null) } : null,
      };
    });
  });
