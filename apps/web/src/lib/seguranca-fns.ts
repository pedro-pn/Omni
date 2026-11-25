import { LIMITES_RISCO } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/** Administração → Segurança: alertas de risco (0065). RLS: só admin e diretoria leem. */

export type AlertaDeRiscoNaTela = {
  id: string;
  tipo: "downloads_em_massa" | "envio_para_fora";
  pessoa: string;
  motivo: string;
  detalhes: { origens?: Record<string, number>; hora?: number; dia?: number; arquivos?: number; bytes?: number };
  em: string;
  vistoPor: string | null;
  vistoEm: string | null;
};

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

const alvo = alias(schema.people, "alvo");
const revisor = alias(schema.people, "revisor");

export const alertasDeRisco = createServerFn({ method: "GET" }).handler(async (): Promise<{ alertas: AlertaDeRiscoNaTela[]; limites: { downloadsPorHora: number; downloadsPorDia: number; enviosPorHora: number; bytesEnviadosPorHora: number } }> => {
  const personId = await pessoa();
  const linhas = await withPerson(getPool(), personId, (db) =>
    db
      .select({ a: schema.riskAlerts, pessoa: alvo.displayName, revisor: revisor.displayName })
      .from(schema.riskAlerts)
      .innerJoin(alvo, eq(alvo.id, schema.riskAlerts.personId))
      .leftJoin(revisor, eq(revisor.id, schema.riskAlerts.reviewedBy))
      .where(gt(schema.riskAlerts.createdAt, new Date(Date.now() - 90 * 24 * 3_600_000)))
      .orderBy(desc(schema.riskAlerts.createdAt))
      .limit(200),
  );
  return {
    limites: { ...LIMITES_RISCO },
    alertas: linhas.map(({ a, pessoa: nome, revisor: quem }) => ({
      id: a.id,
      tipo: a.kind,
      pessoa: nome,
      motivo: a.reason,
      detalhes: a.details as AlertaDeRiscoNaTela["detalhes"],
      em: a.createdAt.toISOString(),
      vistoPor: quem ?? null,
      vistoEm: a.reviewedAt?.toISOString() ?? null,
    })),
  };
});

export const marcarAlertaVisto = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    const r = await withPerson(getPool(), personId, (db) =>
      db
        .update(schema.riskAlerts)
        .set({ reviewedAt: new Date(), reviewedBy: personId })
        .where(and(eq(schema.riskAlerts.id, data.id), isNull(schema.riskAlerts.reviewedAt)))
        .returning({ id: schema.riskAlerts.id }),
    );
    return { ok: r.length > 0 };
  });
