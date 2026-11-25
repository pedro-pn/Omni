import { createHash, randomBytes } from "node:crypto";

import { PRISMA_REDIRECT } from "@omni/core";
import type pg from "pg";

import { hashChave } from "./api-v1.ts";

/**
 * Autorização do Prisma (PKCE S256), mesmo contrato do Foco
 * (`foco/docs/prisma-authorization.md`): POST /api/prisma-authorization/token
 * troca o código de uso único por uma chave `foco_live_…` só de leitura das
 * próprias tarefas; /revoke revoga essa chave. Segredos nascem aqui; o banco
 * só recebe hashes (migration 0012).
 */

const ORIGEM_PRISMA = new URL(PRISMA_REDIRECT).origin;

function responder(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache", "Referrer-Policy": "no-referrer" } });
}

export const novoCodigo = () => randomBytes(32).toString("hex");
export const hashCodigo = (codigo: string) => createHash("sha256").update(codigo, "utf8").digest();
const desafioDe = (verificador: string) => createHash("sha256").update(verificador, "utf8").digest("base64url");

export async function tratarAutorizacaoPrisma(request: Request, pool: pg.Pool, acao: "token" | "revoke"): Promise<Response> {
  if (request.method !== "POST") return responder({ error: "method_not_allowed" }, 405);
  const origem = request.headers.get("origin");
  if (origem && origem !== ORIGEM_PRISMA) return responder({ error: "invalid_origin" }, 403);
  let dados: Record<string, unknown>;
  try {
    if (Number(request.headers.get("content-length")) > 4096) return responder({ error: "invalid_request" }, 400);
    const texto = await request.text();
    if (texto.length > 4096) return responder({ error: "invalid_request" }, 400);
    dados = JSON.parse(texto) as Record<string, unknown>;
  } catch {
    return responder({ error: "invalid_request" }, 400);
  }

  try {
    if (acao === "revoke") {
      if (typeof dados.token !== "string") return responder({ error: "invalid_request" }, 400);
      await pool.query("SELECT app.revogar_chave_prisma($1)", [hashChave(dados.token)]);
      return responder({ revoked: true });
    }

    const { code, code_verifier: verificador, redirect_uri: retorno } = dados;
    if ([code, verificador, retorno].some((v) => typeof v !== "string")) return responder({ error: "invalid_request" }, 400);
    if (dados.client_id !== "prisma" || dados.grant_type !== "authorization_code") return responder({ error: "invalid_request" }, 400);
    if (
      retorno !== PRISMA_REDIRECT ||
      !/^[a-f0-9]{64}$/.test(code as string) ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verificador as string)
    ) {
      return responder({ error: "invalid_grant" }, 400);
    }
    const token = `foco_live_${randomBytes(24).toString("hex")}`;
    const { rows } = await pool.query<{ email: string | null }>("SELECT app.trocar_codigo_prisma($1, $2, $3, $4) AS email", [
      hashCodigo(code as string),
      desafioDe(verificador as string),
      hashChave(token),
      token.slice(0, 18),
    ]);
    const email = rows[0]?.email;
    if (!email) return responder({ error: "invalid_grant" }, 400);
    return responder({ access_token: token, token_type: "Bearer", scope: "tasks:read:self", email: String(email).toLowerCase() });
  } catch (error) {
    console.error("[prisma-authorization] falha:", (error as Error).message);
    return responder({ error: "temporarily_unavailable" }, 503);
  }
}
