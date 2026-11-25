import { TERMOS } from "@omni/core";
import { login, resolveSessionComTermos, SESSION_TTL_HOURS } from "@omni/db";

import { getPool } from "./db.ts";
import { clientIp, parseCookies, serializeCookie } from "./http.ts";

export const SESSION_COOKIE = "omni_session";

/** Sessão do pedido, mesmo sem o termo de uso aceito (só para a página do termo e para getMe). */
export async function sessaoDoRequest(
  request: Request,
): Promise<{ personId: string; termosPendentes: boolean; senhaPendente: boolean; acesso: "microsoft" | "interno" } | null> {
  const token = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE);
  return resolveSessionComTermos(getPool(), token, TERMOS.versao);
}

/**
 * Pessoa da sessão, só com o termo de uso da versão atual aceito (0051) e, no login
 * interno, com a senha provisória já trocada (0078). Faltando um dos dois, devolve
 * null: nenhuma função, download ou evento do Omni abre até a pessoa resolver
 * (/conta/senha e /termos usam sessaoDoRequest).
 */
export async function personIdFromRequest(request: Request): Promise<string | null> {
  const s = await sessaoDoRequest(request);
  return s && !s.termosPendentes && !s.senhaPendente ? s.personId : null;
}

export function sessionTokenFromRequest(request: Request): string | undefined {
  return parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE);
}

/** Abre sessão e devolve o Set-Cookie. */
export async function startSession(
  request: Request,
  identity: { entraOid: string | null; email: string; displayName: string },
): Promise<string> {
  const { token } = await login(getPool(), {
    ...identity,
    userAgent: request.headers.get("user-agent"),
    ip: clientIp(request),
  });
  return serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_TTL_HOURS * 3600 });
}
