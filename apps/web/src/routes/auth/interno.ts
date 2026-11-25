import { caminhoDeVolta } from "@omni/core";
import { loginInterno, SESSION_TTL_HOURS } from "@omni/db";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getPool } from "../../server/db.ts";
import { clientIp, isSameOrigin, redirectTo, serializeCookie } from "../../server/http.ts";
import { SESSION_COOKIE } from "../../server/session.ts";

/**
 * Login interno (0078): usuário e senha, para quem não tem conta Microsoft da empresa.
 * A senha é conferida no banco (bcrypt); 5 erros seguidos bloqueiam a conta por 15 min.
 * Com a senha provisória, a sessão é curta e só abre a troca de senha.
 */
const form = z.object({
  login: z.string().trim().min(1).max(60),
  senha: z.string().min(1).max(200),
  volta: z.string().optional(),
});

export const Route = createFileRoute("/auth/interno")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isSameOrigin(request)) return new Response("Origem inválida", { status: 403 });
        const parsed = form.safeParse(Object.fromEntries(await request.formData()));
        if (!parsed.success) return redirectTo("/entrar?erro=interno-invalido");
        const volta = caminhoDeVolta(parsed.data.volta);
        try {
          const r = await loginInterno(getPool(), { login: parsed.data.login, senha: parsed.data.senha, userAgent: request.headers.get("user-agent"), ip: clientIp(request) });
          if (!r.token) {
            const erro = r.resultado === "bloqueado" ? "interno-bloqueado" : r.resultado === "desativada" ? "conta-desativada" : "interno-invalido";
            return redirectTo(`/entrar?erro=${erro}`);
          }
          const cookie = serializeCookie(SESSION_COOKIE, r.token, { maxAgeSeconds: SESSION_TTL_HOURS * 3600 });
          const destino = r.resultado === "trocar_senha" ? `/conta/senha${volta === "/" ? "" : `?volta=${encodeURIComponent(volta)}`}` : volta;
          return redirectTo(destino, [cookie]);
        } catch (error) {
          console.error("[auth] login interno falhou:", (error as Error).name);
          return redirectTo("/entrar?erro=falha-login");
        }
      },
    },
  },
});
