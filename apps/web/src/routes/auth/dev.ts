import { caminhoDeVolta } from "@omni/core";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ambienteDe, getEnv } from "../../server/env.ts";
import { isSameOrigin, redirectTo } from "../../server/http.ts";
import { startSession } from "../../server/session.ts";

/** Login de desenvolvimento, sem Microsoft. A validação do ambiente o proíbe em produção. */
const form = z.object({
  email: z.email().max(200),
  nome: z.string().trim().min(2).max(120),
  volta: z.string().optional(),
});

export const Route = createFileRoute("/auth/dev")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const env = getEnv();
        if (env.AUTH_DEV_LOGIN !== "on" || env.NODE_ENV === "production" || ambienteDe(env) !== "desenvolvimento") {
          return new Response("Não encontrado", { status: 404 });
        }
        if (!isSameOrigin(request)) return new Response("Origem inválida", { status: 403 });
        const parsed = form.safeParse(Object.fromEntries(await request.formData()));
        if (!parsed.success) return redirectTo("/entrar?erro=dados-invalidos");
        try {
          const cookie = await startSession(request, {
            entraOid: null,
            email: parsed.data.email,
            displayName: parsed.data.nome,
          });
          return redirectTo(caminhoDeVolta(parsed.data.volta), [cookie]);
        } catch (error) {
          console.error("[auth] login de desenvolvimento falhou:", (error as Error).message);
          return redirectTo("/entrar?erro=falha-login");
        }
      },
    },
  },
});
