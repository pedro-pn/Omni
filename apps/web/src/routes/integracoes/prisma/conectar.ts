import { novoFluxoPkce, urlAutorizacao } from "@omni/integrations/prisma";
import { createFileRoute } from "@tanstack/react-router";

import { selar } from "../../../server/crypto.ts";
import { getEnv } from "../../../server/env.ts";
import { redirectTo, serializeCookie } from "../../../server/http.ts";
import {
  PRISMA_COOKIE_PATH,
  PRISMA_FLOW_COOKIE,
  PROPOSITO_FLUXO_PRISMA,
  prismaRedirectUri,
  type FluxoPrisma,
} from "../../../server/prisma.ts";
import { personIdFromRequest } from "../../../server/session.ts";

/** Inicia a autorização no Prisma (Authorization Code + PKCE S256). */
export const Route = createFileRoute("/integracoes/prisma/conectar")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return redirectTo("/entrar");
        const env = getEnv();
        const pkce = novoFluxoPkce();
        const fluxo: FluxoPrisma = {
          state: pkce.state,
          verifier: pkce.verifier,
          personId,
          expiresAt: Date.now() + 10 * 60 * 1000,
        };
        const url = urlAutorizacao({
          baseUrl: env.PRISMA_BASE_URL,
          environment: env.PRISMA_OMNI_ENVIRONMENT,
          redirectUri: prismaRedirectUri(),
          state: pkce.state,
          challenge: pkce.challenge,
        });
        const cookie = serializeCookie(PRISMA_FLOW_COOKIE, selar(fluxo, PROPOSITO_FLUXO_PRISMA), {
          maxAgeSeconds: 600,
          path: PRISMA_COOKIE_PATH,
        });
        return redirectTo(url, [cookie], 302);
      },
    },
  },
});
