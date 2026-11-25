import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";

import type pg from "pg";

/**
 * Sessões do Omni. O navegador guarda só o token aleatório (cookie httpOnly);
 * o banco guarda só o sha256. Leitura e escrita passam pelas funções
 * SECURITY DEFINER `app.login`, `app.resolve_session` e `app.logout`.
 */

export const SESSION_TTL_HOURS = 12;

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export type LoginInput = {
  entraOid: string | null;
  email: string;
  displayName: string;
  userAgent?: string | null;
  ip?: string | null;
  ttlHours?: number;
};

export async function login(pool: pg.Pool, input: LoginInput): Promise<{ personId: string; token: string }> {
  const token = newSessionToken();
  const ttl = `${input.ttlHours ?? SESSION_TTL_HOURS} hours`;
  const ip = input.ip && isIP(input.ip) ? input.ip : null;
  const { rows } = await pool.query<{ person_id: string }>(
    "SELECT app.login($1, $2, $3, $4, $5::interval, $6, $7::inet) AS person_id",
    [input.entraOid, input.email.trim().toLowerCase(), input.displayName, hashSessionToken(token), ttl, input.userAgent ?? null, ip],
  );
  const personId = rows[0]?.person_id;
  if (!personId) throw new Error("Login não retornou pessoa");
  return { personId, token };
}

/** Sessão e se falta aceitar a versão atual do termo de uso (0051). null sem sessão válida. */
export async function resolveSessionComTermos(
  pool: pg.Pool,
  token: string | undefined | null,
  versaoTermos: string,
): Promise<{ personId: string; termosPendentes: boolean; senhaPendente: boolean; acesso: "microsoft" | "interno" } | null> {
  if (!token || token.length > 128) return null;
  const { rows } = await pool.query<{ person_id: string; termos_pendentes: boolean; senha_pendente: boolean; acesso: "microsoft" | "interno" }>(
    "SELECT * FROM app.sessao_com_termos($1, $2)",
    [hashSessionToken(token), versaoTermos],
  );
  const r = rows[0];
  return r ? { personId: r.person_id, termosPendentes: r.termos_pendentes, senhaPendente: r.senha_pendente, acesso: r.acesso } : null;
}

export type ResultadoLoginInterno = "ok" | "trocar_senha" | "invalido" | "bloqueado" | "desativada";

/** Login interno (0078): a senha é conferida no banco; abre sessão só se der certo. */
export async function loginInterno(
  pool: pg.Pool,
  input: { login: string; senha: string; userAgent?: string | null; ip?: string | null; ttlHours?: number },
): Promise<{ resultado: ResultadoLoginInterno; personId: string | null; token: string | null }> {
  const token = newSessionToken();
  const ttl = `${input.ttlHours ?? SESSION_TTL_HOURS} hours`;
  const ip = input.ip && isIP(input.ip) ? input.ip : null;
  const { rows } = await pool.query<{ person_id: string | null; resultado: ResultadoLoginInterno }>(
    "SELECT * FROM app.login_interno($1, $2, $3, $4::interval, $5, $6::inet)",
    [input.login, input.senha, hashSessionToken(token), ttl, input.userAgent ?? null, ip],
  );
  const r = rows[0];
  const ok = r?.resultado === "ok" || r?.resultado === "trocar_senha";
  return { resultado: r?.resultado ?? "invalido", personId: ok ? r!.person_id : null, token: ok ? token : null };
}

export async function resolveSession(pool: pg.Pool, token: string | undefined | null): Promise<string | null> {
  if (!token || token.length > 128) return null;
  const { rows } = await pool.query<{ person_id: string | null }>("SELECT app.resolve_session($1) AS person_id", [
    hashSessionToken(token),
  ]);
  return rows[0]?.person_id ?? null;
}

export async function logout(pool: pg.Pool, token: string | undefined | null): Promise<void> {
  if (!token) return;
  await pool.query("SELECT app.logout($1)", [hashSessionToken(token)]);
}
