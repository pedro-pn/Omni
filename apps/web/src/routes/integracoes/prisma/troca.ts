import { timingSafeEqual } from "node:crypto";

import { PrismaError, trocarCodigo } from "@omni/integrations/prisma";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { abrir } from "../../../server/crypto.ts";
import { getEnv } from "../../../server/env.ts";
import { clearCookie, isSameOrigin, parseCookies } from "../../../server/http.ts";
import {
  PRISMA_COOKIE_PATH,
  PRISMA_FLOW_COOKIE,
  PROPOSITO_FLUXO_PRISMA,
  prismaRedirectUri,
  salvarCredencial,
  type FluxoPrisma,
} from "../../../server/prisma.ts";
import { personIdFromRequest } from "../../../server/session.ts";

const corpo = z.object({
  code: z.string().min(1).max(512),
  state: z.string().regex(/^[A-Za-z0-9_.~-]{16,200}$/),
});

function json(body: unknown, status: number, cookies: string[] = []): Response {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

function mesmoTexto(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Troca o código do Prisma no servidor. Chamada pela página de retorno depois de
 * ler e apagar o fragmento (#code=…&state=…). O fluxo é de uso único: o cookie
 * sai na resposta, e o Prisma revoga o token se a mesma troca se repetir.
 */
export const Route = createFileRoute("/integracoes/prisma/troca")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isSameOrigin(request)) return json({ erro: "origem-invalida" }, 403);
        const personId = await personIdFromRequest(request);
        if (!personId) return json({ erro: "sessao-expirada" }, 401);

        const limparFluxo = clearCookie(PRISMA_FLOW_COOKIE, PRISMA_COOKIE_PATH);
        const fluxo = abrir<FluxoPrisma>(parseCookies(request.headers.get("cookie")).get(PRISMA_FLOW_COOKIE), PROPOSITO_FLUXO_PRISMA);
        const dados = corpo.safeParse(await request.json().catch(() => null));
        if (
          !fluxo ||
          !dados.success ||
          fluxo.expiresAt <= Date.now() ||
          fluxo.personId !== personId ||
          !mesmoTexto(fluxo.state, dados.data.state)
        ) {
          return json({ erro: "fluxo-invalido" }, 400, [limparFluxo]);
        }

        try {
          const env = getEnv();
          const credencial = await trocarCodigo({
            baseUrl: env.PRISMA_BASE_URL,
            code: dados.data.code,
            verifier: fluxo.verifier,
            redirectUri: prismaRedirectUri(),
          });
          if (credencial.environment !== env.PRISMA_OMNI_ENVIRONMENT) {
            return json({ erro: "ambiente-divergente" }, 409, [limparFluxo]);
          }
          await salvarCredencial(personId, credencial);
          return json(
            { ok: true, environment: credencial.environment, expiresAt: credencial.expiresAt.toISOString(), scopes: credencial.scopes },
            200,
            [limparFluxo],
          );
        } catch (error) {
          const codigo = error instanceof PrismaError ? (error.code ?? `http-${error.status}`) : "falha";
          console.error("[prisma] troca do código falhou:", (error as Error).message);
          return json({ erro: "troca-recusada", codigo }, 502, [limparFluxo]);
        }
      },
    },
  },
});
