import { schema, withPerson } from "@omni/db";
import { PrismaClient, type CredencialPrisma } from "@omni/integrations/prisma";
import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { decifrar, cifrar } from "./crypto.ts";
import { getPool } from "./db.ts";
import { getEnv } from "./env.ts";

/**
 * Conexão individual com o Prisma CRM (PKCE). O fluxo (state + verificador)
 * fica num cookie cifrado de 10 min restrito a /integracoes/prisma; o token
 * emitido fica cifrado em `prisma_credentials` (RLS: só a própria pessoa).
 */

export const PRISMA_FLOW_COOKIE = "omni_prisma_flow";
export const PRISMA_COOKIE_PATH = "/integracoes/prisma";
export const PRISMA_RETORNO_PATH = "/integracoes/prisma/retorno";
export const PROPOSITO_FLUXO_PRISMA = "prisma-pkce-flow-v1";
const PROPOSITO_TOKEN_PRISMA = "prisma-user-token-v1";

export type FluxoPrisma = { state: string; verifier: string; personId: string; expiresAt: number };

/** URI de retorno exata cadastrada no Prisma (comparação literal). */
export function prismaRedirectUri(): string {
  return new URL(PRISMA_RETORNO_PATH, getEnv().APP_ORIGIN).toString();
}

export async function salvarCredencial(personId: string, credencial: CredencialPrisma): Promise<void> {
  const valores = {
    environment: credencial.environment,
    tokenCiphertext: cifrar(credencial.accessToken, PROPOSITO_TOKEN_PRISMA),
    scopes: credencial.scopes,
    expiresAt: credencial.expiresAt,
  };
  await withPerson(getPool(), personId, async (db) => {
    await db
      .insert(schema.prismaCredentials)
      .values({ personId, ...valores })
      .onConflictDoUpdate({ target: schema.prismaCredentials.personId, set: valores });
    await db.insert(schema.auditLog).values({
      actorPersonId: personId,
      action: "prisma.conectado",
      entityType: "prisma_credentials",
      entityId: personId,
      metadata: { environment: credencial.environment, scopes: credencial.scopes },
    });
  });
}

export type ConexaoPrisma = { environment: "sandbox" | "production"; expiresAt: string; scopes: string[]; valida: boolean };

/** Situação da conexão da pessoa (sem abrir o token). */
export async function conexaoPrisma(personId: string): Promise<ConexaoPrisma | null> {
  const [linha] = await withPerson(getPool(), personId, (db) =>
    db.select().from(schema.prismaCredentials).where(eq(schema.prismaCredentials.personId, personId)),
  );
  if (!linha) return null;
  return {
    environment: linha.environment,
    expiresAt: linha.expiresAt.toISOString(),
    scopes: linha.scopes,
    valida: linha.expiresAt > new Date() && linha.environment === getEnv().PRISMA_OMNI_ENVIRONMENT,
  };
}

/** Cliente do Prisma com a credencial da pessoa, ou null se não houver uma válida. */
export async function clientePrismaDaPessoa(personId: string): Promise<PrismaClient | null> {
  const [linha] = await withPerson(getPool(), personId, (db) =>
    db.select().from(schema.prismaCredentials).where(eq(schema.prismaCredentials.personId, personId)),
  );
  const env = getEnv();
  if (!linha || linha.expiresAt <= new Date() || linha.environment !== env.PRISMA_OMNI_ENVIRONMENT) return null;
  return new PrismaClient({
    token: decifrar(linha.tokenCiphertext, PROPOSITO_TOKEN_PRISMA),
    environment: linha.environment,
    baseUrl: env.PRISMA_BASE_URL,
  });
}

export async function desconectarPrisma(personId: string): Promise<void> {
  await withPerson(getPool(), personId, async (db) => {
    await db.delete(schema.prismaCredentials).where(eq(schema.prismaCredentials.personId, personId));
    await db.insert(schema.auditLog).values({
      actorPersonId: personId,
      action: "prisma.desconectado",
      entityType: "prisma_credentials",
      entityId: personId,
    });
  });
}

/** Cliente de leitura (credencial `reader`), para o bloco "No Prisma"; null sem a credencial. */
let leitor: PrismaClient | null | undefined;
export function clienteLeituraPrisma(): PrismaClient | null {
  if (leitor !== undefined) return leitor;
  const env = getEnv();
  leitor = env.PRISMA_OMNI_READER_TOKEN ? new PrismaClient({ token: env.PRISMA_OMNI_READER_TOKEN, environment: env.PRISMA_OMNI_ENVIRONMENT, baseUrl: env.PRISMA_BASE_URL }) : null;
  return leitor;
}

/** UUID fixo a partir de um texto: a mesma operação repetida usa a mesma chave de idempotência no Prisma. */
export function chaveDeterministica(texto: string): string {
  const h = createHash("sha256").update(`omni-prisma:${texto}`).digest("hex");
  const variante = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variante}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Endereço do Omni que o Prisma aceita em `sourceUrl` (https do Omni; no sandbox, também o staging). */
export function enderecoOmniParaPrisma(caminho: string): string {
  const env = getEnv();
  const origem = env.APP_ORIGIN.replace(/\/$/, "");
  const aceita = /^https:\/\/omni(staging)?\.filtrovali\.com\.br$/.test(origem) ? origem : "https://omnistaging.filtrovali.com.br";
  return `${aceita}${caminho}`;
}
