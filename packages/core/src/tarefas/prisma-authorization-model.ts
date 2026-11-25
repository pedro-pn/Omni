export const PRISMA_REDIRECT = "https://prismacrm.filtrovali.com.br/";
export type PrismaConsentRequest = { challenge: string; state: string; email: string };

export function parsePrismaConsent(search: string): PrismaConsentRequest | null {
  const p = new URLSearchParams(search);
  if (p.get("client_id") !== "prisma" || p.get("redirect_uri") !== PRISMA_REDIRECT ||
      p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256") return null;
  const challenge = p.get("code_challenge") ?? "";
  const state = p.get("state") ?? "";
  const email = p.get("email") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || !/^[a-f0-9]{64}$/.test(state) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;
  return { challenge, state, email };
}

export function prismaConsentReturn(state: string, result: { code: string } | { error: string }) {
  return `${PRISMA_REDIRECT}#foco-callback?${new URLSearchParams({ state, ...result })}`;
}

const pendingKey = "foco-prisma-consent-login";
export function rememberPrismaConsent(search: string, storage: Pick<Storage, "setItem">, now = Date.now()) {
  const p = new URLSearchParams(search);
  if (!parsePrismaConsent(search) && !(p.get("integracao") === "prisma" && p.get("manage") === "1")) return;
  storage.setItem(pendingKey, JSON.stringify({ search, expiresAt: now + 300_000 }));
}
export function restorePrismaConsent(search: string, storage: Pick<Storage, "getItem" | "removeItem">, now = Date.now()) {
  try {
    if (new URLSearchParams(search).get("integracao") === "prisma") return search;
    const raw = storage.getItem(pendingKey); storage.removeItem(pendingKey);
    if (!raw) return search;
    const pending = JSON.parse(raw) as { search: string; expiresAt: number };
    if (typeof pending.search !== "string" || !Number.isFinite(pending.expiresAt) || pending.expiresAt < now || pending.expiresAt > now + 300_000) return search;
    const p = new URLSearchParams(pending.search);
    if (parsePrismaConsent(pending.search) || (p.get("integracao") === "prisma" && p.get("manage") === "1")) return `?${p}`;
  } catch { /* Storage may be disabled; a new authorization remains available. */ }
  return search;
}
