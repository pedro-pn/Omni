import { randomBytes } from "node:crypto";

import { parsePrismaConsent } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { hashChave } from "../server/api-v1.ts";
import { hashCodigo, novoCodigo } from "../server/autorizacao-prisma.ts";
import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Chaves pessoais da API /api/v1 (Meu perfil → API e automações) e a tela de
 * consentimento do Prisma. A chave aparece uma vez só; o banco guarda o hash.
 */

export class ApiChavesError extends ErroParaTela {}

async function exigirPessoa(): Promise<string> {
  const personId = await personIdFromRequest(getRequest());
  if (!personId) throw new ApiChavesError("Sessão expirada. Entre de novo.");
  return personId;
}

export type ChaveApi = {
  id: string;
  nome: string;
  prefixo: string;
  escopos: string[];
  prisma: boolean;
  criadaEm: string;
  usadaEm: string | null;
  revogadaEm: string | null;
};

export const listarChaves = createServerFn({ method: "GET" }).handler(async (): Promise<ChaveApi[]> => {
  const meuId = await exigirPessoa();
  const linhas = await withPerson(getPool(), meuId, (db) => db.select().from(schema.apiKeys).orderBy(desc(schema.apiKeys.createdAt)));
  return linhas.map((k) => ({
    id: k.id,
    nome: k.name,
    prefixo: k.keyPrefix,
    escopos: k.scopes,
    prisma: k.client === "prisma",
    criadaEm: k.createdAt.toISOString(),
    usadaEm: k.lastUsedAt?.toISOString() ?? null,
    revogadaEm: k.revokedAt?.toISOString() ?? null,
  }));
});

export const criarChave = createServerFn({ method: "POST" })
  .validator(z.object({ nome: z.string().trim().min(2, "Dê um nome à chave.").max(80), escrita: z.boolean() }))
  .handler(async ({ data }): Promise<{ chave: string }> => {
    const meuId = await exigirPessoa();
    // Mesmo formato das chaves do Foco (o Prisma e as automações validam o prefixo).
    const chave = `foco_live_${randomBytes(24).toString("hex")}`;
    const escopos = data.escrita ? "{read,write}" : "{read}";
    try {
      await withPerson(getPool(), meuId, (db) =>
        db.execute(sql`SELECT app.criar_chave_api(${data.nome}, ${escopos}::text[], ${hashChave(chave)}, ${chave.slice(0, 18)})`),
      );
    } catch (error) {
      // Nunca devolver a mensagem do banco (traz a consulta e os parâmetros).
      console.error("[api] falha ao criar chave:", (error as { cause?: Error }).cause?.message ?? "erro");
      throw new ApiChavesError("Não foi possível criar a chave. Confira se o seu acesso ao Omni está liberado.");
    }
    return { chave };
  });

export const revogarChave = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid().optional(), prisma: z.boolean().optional() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const meuId = await exigirPessoa();
    await withPerson(getPool(), meuId, (db) =>
      db
        .update(schema.apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            isNull(schema.apiKeys.revokedAt),
            data.id ? eq(schema.apiKeys.id, data.id) : undefined,
            data.prisma ? eq(schema.apiKeys.client, "prisma") : undefined,
          ),
        ),
    );
    return { ok: true as const };
  });

/** Consentimento: emite o código de uso único e devolve para onde voltar no Prisma. */
export const autorizarPrisma = createServerFn({ method: "POST" })
  .validator(z.object({ busca: z.string().max(2000) }))
  .handler(async ({ data }): Promise<{ codigo: string; estado: string }> => {
    const meuId = await exigirPessoa();
    const pedido = parsePrismaConsent(data.busca);
    if (!pedido) throw new ApiChavesError("Este pedido de conexão é inválido. Volte ao Prisma e comece de novo.");
    const codigo = novoCodigo();
    try {
      await withPerson(getPool(), meuId, (db) =>
        db.execute(sql`SELECT app.emitir_codigo_prisma(${hashCodigo(codigo)}, ${pedido.challenge}, ${pedido.email})`),
      );
    } catch {
      throw new ApiChavesError(`Entre no Omni com ${pedido.email}, o mesmo e-mail usado no Prisma.`);
    }
    return { codigo, estado: pedido.state };
  });
