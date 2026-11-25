import { getEnv, isSecureOrigin } from "./env.ts";

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out.set(name, decodeURIComponent(value));
    } catch {
      // cookie malformado: ignora
    }
  }
  return out;
}

type CookieOptions = { maxAgeSeconds?: number; path?: string };

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? "/"}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecureOrigin()) parts.push("Secure");
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  return parts.join("; ");
}

export function clearCookie(name: string, path = "/"): string {
  return serializeCookie(name, "", { maxAgeSeconds: 0, path });
}

/** Redireciona, com cookies opcionais. */
export function redirectTo(location: string, cookies: string[] = [], status = 303): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}

/** Proteção CSRF para POST: a origem precisa ser o próprio Omni. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(getEnv().APP_ORIGIN).origin;
}

export function clientIp(request: Request): string | null {
  // Atrás do Caddy, o IP real vem no X-Forwarded-For (primeiro da lista).
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || null;
}
