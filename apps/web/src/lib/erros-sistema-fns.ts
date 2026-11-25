import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/** Administração → Erros (E09, migration 0079). RLS: só quem tem o perfil admin lê e marca como visto. */

export type ErroDoSistemaNaTela = {
  id: string;
  origem: "web" | "worker" | "operacao";
  nome: string;
  mensagem: string;
  detalhe: string | null;
  local: string;
  versao: string | null;
  ocorrencias: number;
  primeiraVez: string;
  ultimaVez: string;
  vistoPor: string | null;
  vistoEm: string | null;
};

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

const revisor = alias(schema.people, "revisor");

export const errosDoSistema = createServerFn({ method: "GET" }).handler(async (): Promise<ErroDoSistemaNaTela[]> => {
  const personId = await pessoa();
  const linhas = await withPerson(getPool(), personId, (db) =>
    db
      .select({ e: schema.systemErrors, revisor: revisor.displayName })
      .from(schema.systemErrors)
      .leftJoin(revisor, eq(revisor.id, schema.systemErrors.reviewedBy))
      .orderBy(desc(schema.systemErrors.lastSeen))
      .limit(200),
  );
  return linhas.map(({ e, revisor: quem }) => ({
    id: e.id,
    origem: e.source,
    nome: e.name,
    mensagem: e.message,
    detalhe: e.detail,
    local: e.location,
    versao: e.version,
    ocorrencias: e.occurrences,
    primeiraVez: e.firstSeen.toISOString(),
    ultimaVez: e.lastSeen.toISOString(),
    vistoPor: quem ?? null,
    vistoEm: e.reviewedAt?.toISOString() ?? null,
  }));
});

export const marcarErroVisto = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    const r = await withPerson(getPool(), personId, (db) =>
      db
        .update(schema.systemErrors)
        .set({ reviewedAt: new Date(), reviewedBy: personId })
        .where(and(eq(schema.systemErrors.id, data.id), isNull(schema.systemErrors.reviewedAt)))
        .returning({ id: schema.systemErrors.id }),
    );
    return { ok: r.length > 0 };
  });
