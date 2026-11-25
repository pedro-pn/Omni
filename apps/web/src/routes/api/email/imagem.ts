import { createFileRoute } from "@tanstack/react-router";

import { buscarImagem, ImagemIndisponivel, urlAssinada } from "../../../server/email-imagem.ts";
import { getEnv } from "../../../server/env.ts";
import { personIdFromRequest } from "../../../server/session.ts";

/**
 * Imagem da internet citada num e-mail, buscada pelo Omni (proxy, como o Outlook na
 * web). Só com sessão e só endereços assinados ao montar o e-mail; travas de rede
 * em server/email-imagem.ts. A imagem não fica guardada no Omni (só no cache do navegador).
 */

const texto = (msg: string, status: number) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export const Route = createFileRoute("/api/email/imagem")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await personIdFromRequest(request))) return texto("Sessão expirada.", 401);
        const q = new URL(request.url).searchParams;
        const url = urlAssinada(getEnv().AUTH_SECRET, q.get("u"), q.get("s"));
        if (!url) return texto("Imagem inválida.", 400);
        try {
          const img = await buscarImagem(url);
          return new Response(new Uint8Array(img.conteudo), {
            headers: {
              "Content-Type": img.tipo,
              "Content-Length": String(img.conteudo.length),
              "Cache-Control": "private, max-age=86400",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
              "Cross-Origin-Resource-Policy": "same-origin",
            },
          });
        } catch (error) {
          if (error instanceof ImagemIndisponivel) return texto("Imagem indisponível.", 404);
          throw error;
        }
      },
    },
  },
});
