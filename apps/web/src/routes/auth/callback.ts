import { caminhoDeVolta } from "@omni/core";
import { createFileRoute } from "@tanstack/react-router";

import { clearCookie, parseCookies, redirectTo } from "../../server/http.ts";
import { CALLBACK_PATH, completeMicrosoftLogin, FLOW_COOKIE, LoginError } from "../../server/microsoft.ts";
import { startSession } from "../../server/session.ts";

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const clearFlow = clearCookie(FLOW_COOKIE, CALLBACK_PATH);
        if (url.searchParams.get("error")) return redirectTo("/entrar?erro=microsoft-recusou", [clearFlow]);
        try {
          const identity = await completeMicrosoftLogin({
            code: url.searchParams.get("code"),
            state: url.searchParams.get("state"),
            flowCookieValue: parseCookies(request.headers.get("cookie")).get(FLOW_COOKIE),
          });
          const sessionCookie = await startSession(request, {
            entraOid: identity.objectId,
            email: identity.email,
            displayName: identity.displayName,
          });
          return redirectTo(caminhoDeVolta(identity.volta), [clearFlow, sessionCookie]);
        } catch (error) {
          const code =
            error instanceof LoginError
              ? "login-invalido"
              : /desativada/.test(String((error as Error).message))
                ? "conta-desativada"
                : "falha-login";
          console.error("[auth] falha no retorno da Microsoft:", (error as Error).message);
          return redirectTo(`/entrar?erro=${code}`, [clearFlow]);
        }
      },
    },
  },
});
