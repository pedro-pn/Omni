import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

import { ConfidentialClientApplication } from "@azure/msal-node";

import { abrir, selar } from "./crypto.ts";
import { getEnv } from "./env.ts";

/**
 * Login Microsoft Entra ID — mesmo desenho do comercialAPP
 * (comercialAPP/backend/src/auth/microsoft.js): código de autorização + PKCE S256,
 * estado/nonce/verificador num cookie cifrado (AES-256-GCM) de 10 minutos e
 * validação de tenant, audiência, emissor e nonce nas claims.
 * MFA é exigido pelo Acesso Condicional do tenant, não pelo app.
 */

export const FLOW_COOKIE = "omni_login_flow";
export const CALLBACK_PATH = "/auth/callback";
const SCOPES = ["openid", "profile", "email"];
const FLOW_LIFETIME_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Flow = { state: string; nonce: string; verifier: string; expiresAt: number; volta?: string };

export class LoginError extends Error {}

const PROPOSITO_FLUXO = "entra-login-flow-v1";

function openFlow(value: string | undefined): Flow {
  const flow = abrir<Flow>(value, PROPOSITO_FLUXO);
  if (!flow) throw new LoginError("Tentativa de login inválida ou expirada.");
  return flow;
}

let client: ConfidentialClientApplication | undefined;

function msal(): ConfidentialClientApplication {
  if (client) return client;
  const env = getEnv();
  const credential = env.ENTRA_PRIVATE_KEY_PATH
    ? {
        clientCertificate: {
          thumbprintSha256: env.ENTRA_CERT_SHA256_THUMBPRINT!,
          privateKey: readFileSync(env.ENTRA_PRIVATE_KEY_PATH, "utf8"),
        },
      }
    : { clientSecret: env.ENTRA_CLIENT_SECRET! };
  client = new ConfidentialClientApplication({
    auth: { clientId: env.ENTRA_CLIENT_ID!, authority: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}`, ...credential },
  });
  return client;
}

function redirectUri(): string {
  return new URL(CALLBACK_PATH, getEnv().APP_ORIGIN).toString();
}

export function microsoftLoginEnabled(): boolean {
  return getEnv().ENTRA_LOGIN_ENABLED === "on";
}

/** `volta`: caminho interno para onde ir depois do login (já validado com caminhoDeVolta). */
export async function startMicrosoftLogin(volta = "/"): Promise<{ url: string; flowCookieValue: string }> {
  const flow: Flow = {
    volta,
    state: randomBytes(32).toString("hex"),
    nonce: randomBytes(32).toString("hex"),
    verifier: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + FLOW_LIFETIME_MS,
  };
  const url = await msal().getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: redirectUri(),
    state: flow.state,
    nonce: flow.nonce,
    codeChallenge: createHash("sha256").update(flow.verifier).digest("base64url"),
    codeChallengeMethod: "S256",
    prompt: "select_account",
  });
  return { url, flowCookieValue: selar(flow, PROPOSITO_FLUXO) };
}

export type MicrosoftIdentity = { objectId: string; email: string; displayName: string; volta: string };

export async function completeMicrosoftLogin(params: {
  code: string | null;
  state: string | null;
  flowCookieValue: string | undefined;
}): Promise<MicrosoftIdentity> {
  const env = getEnv();
  const flow = openFlow(params.flowCookieValue);
  const received = Buffer.from(params.state ?? "", "utf8");
  const expected = Buffer.from(flow.state, "utf8");
  if (
    flow.expiresAt <= Date.now() ||
    received.length !== expected.length ||
    !timingSafeEqual(received, expected) ||
    !params.code ||
    params.code.length > 4096
  ) {
    throw new LoginError("Tentativa de login inválida ou expirada.");
  }

  const result = await msal().acquireTokenByCode({
    code: params.code,
    scopes: SCOPES,
    redirectUri: redirectUri(),
    codeVerifier: flow.verifier,
    // msal-node 7 exige o nonce também na troca do código (sem ele: nonce_mismatch); a conferência abaixo continua.
    nonce: flow.nonce,
  });
  const claims = (result?.idTokenClaims ?? {}) as Record<string, unknown>;
  const tenantId = env.ENTRA_TENANT_ID!.toLowerCase();
  if (
    String(claims.tid ?? "").toLowerCase() !== tenantId ||
    String(claims.aud ?? "").toLowerCase() !== env.ENTRA_CLIENT_ID!.toLowerCase() ||
    claims.nonce !== flow.nonce ||
    !UUID.test(String(claims.oid ?? "")) ||
    claims.iss !== `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`
  ) {
    throw new LoginError("Identidade Microsoft inválida.");
  }

  const email = String(claims.email ?? claims.preferred_username ?? "").toLowerCase();
  if (!email.includes("@")) throw new LoginError("A conta Microsoft não tem e-mail.");
  return {
    objectId: String(claims.oid).toLowerCase(),
    email,
    displayName: String(claims.name ?? email),
    volta: flow.volta ?? "/",
  };
}
