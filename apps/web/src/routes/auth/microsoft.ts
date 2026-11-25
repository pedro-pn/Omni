import { caminhoDeVolta } from "@omni/core";
import { createFileRoute } from "@tanstack/react-router";

import { redirectTo, serializeCookie } from "../../server/http.ts";
import { CALLBACK_PATH, FLOW_COOKIE, microsoftLoginEnabled, startMicrosoftLogin } from "../../server/microsoft.ts";

export const Route = createFileRoute("/auth/microsoft")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!microsoftLoginEnabled()) return redirectTo("/entrar?erro=microsoft-desligado");
        const volta = caminhoDeVolta(new URL(request.url).searchParams.get("volta"));
        const { url, flowCookieValue } = await startMicrosoftLogin(volta);
        return redirectTo(url, [serializeCookie(FLOW_COOKIE, flowCookieValue, { maxAgeSeconds: 600, path: CALLBACK_PATH })], 302);
      },
    },
  },
});
