import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { getEnv } from "../server/env.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Abas RDOs e Relatórios da missão (INSTRUCOES §6.10): o que o filtroAPP
 * sincronizou em `reports` (quem vê a missão lê, 0045) e, para quem vê o Interno, o que
 * a IA apontou na leitura diária (`rdo_analyses`, migration 0034). O documento
 * continua no filtroAPP; o Omni não guarda nem recalcula.
 */

export type SituacaoRelatorio = "PENDING" | "RETURNED" | "APPROVED" | "SIGNED";

export type PontoIA = { tipo: string; resumo: string; trecho: string | null };

export type RelatorioDaMissao = {
  id: string;
  tipo: string;
  numero: string | null;
  sequencia: number | null;
  data: string;
  situacao: SituacaoRelatorio;
  minutos: number | null;
  minutosExtra: number | null;
  descricao: string | null;
  motivoExtra: string | null;
  enviadoEm: string | null;
  aprovadoEm: string | null;
  devolvidoEm: string | null;
  assinadoEm: string | null;
  /** Pontos da leitura da IA; null quando não leu (ou a pessoa não vê o Interno). */
  pontosIA: PontoIA[] | null;
  /** PDF no filtroAPP (spec 038): true pronto, false ainda não, null desconhecido. */
  pdf: { disponivel: boolean | null; versao: string | null; anexos: string[] };
};

export type RelatoriosDaMissao = { veInterno: boolean; pdfConfigurado: boolean; rdos: RelatorioDaMissao[]; tecnicos: RelatorioDaMissao[] };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const ehRdo = (tipo: string) => tipo.startsWith("RDO");

export const listarRelatoriosDaMissao = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<RelatoriosDaMissao> => {
    const personId = await personIdFromRequest(getRequest());
    if (!personId) throw new ErroParaTela("Sessão expirada. Entre de novo.");
    return withPerson(getPool(), personId, async (db) => {
      const [acesso] = (await db.execute<{ ok: boolean }>(sql`SELECT app.ve_interno(${data.missionId}::uuid, ${personId}::uuid) AS ok`)).rows;
      const veInterno = Boolean(acesso?.ok);
      const linhas = await db
        .select()
        .from(schema.reports)
        .where(eq(schema.reports.missionId, data.missionId))
        .orderBy(desc(schema.reports.reportDate), desc(schema.reports.sequenceNumber));
      // Sem acesso ao Interno a RLS devolve nada; a consulta só roda para quem vê.
      const leituras = veInterno
        ? await db
            .select({ id: schema.rdoAnalyses.reportId, pontos: schema.rdoAnalyses.points })
            .from(schema.rdoAnalyses)
            .where(eq(schema.rdoAnalyses.missionId, data.missionId))
        : [];
      const pontos = new Map(leituras.map((l) => [l.id, l.pontos]));
      const itens = linhas.map(
        (r): RelatorioDaMissao => ({
          id: r.id,
          tipo: r.reportType,
          numero: r.reportNumber,
          sequencia: r.sequenceNumber,
          data: r.reportDate,
          situacao: r.status,
          minutos: r.workedMinutes,
          minutosExtra: r.overtimeMinutes,
          descricao: r.dailyDescription,
          motivoExtra: r.overtimeReason,
          enviadoEm: iso(r.submittedAt),
          aprovadoEm: iso(r.approvedAt),
          devolvidoEm: iso(r.returnedAt),
          assinadoEm: iso(r.signedAt),
          pontosIA: pontos.get(r.id) ?? null,
          pdf: { disponivel: r.pdfDisponivel, versao: r.pdfVersao, anexos: r.pdfAnexosManutencao },
        }),
      );
      return { veInterno, pdfConfigurado: Boolean(getEnv().FILTROAPP_API_TOKEN), rdos: itens.filter((r) => ehRdo(r.tipo)), tecnicos: itens.filter((r) => !ehRdo(r.tipo)) };
    });
  });
