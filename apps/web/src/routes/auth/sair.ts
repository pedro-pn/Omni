import { logout } from "@omni/db";
import { createFileRoute } from "@tanstack/react-router";

import { getPool } from "../../server/db.ts";
import { clearCookie, isSameOrigin, redirectTo } from "../../server/http.ts";
import { SESSION_COOKIE, sessionTokenFromRequest } from "../../server/session.ts";

export const Route = createFileRoute("/auth/sair")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isSameOrigin(request)) return new Response("Origem inválida", { status: 403 });
        await logout(getPool(), sessionTokenFromRequest(request));
        return redirectTo("/entrar", [clearCookie(SESSION_COOKIE)]);
      },
    },
  },
});
