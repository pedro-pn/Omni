import { createHash } from "node:crypto";

import { createFileRoute } from "@tanstack/react-router";

import { getPool } from "../../../../../server/db.ts";
import { montarAgenda, pessoaDoLink } from "../../../../../server/agenda.ts";

/**
 * Link privado da agenda (.ics) — mesmo endereço do Foco
 * (`/api/calendar/apple/feed/<id>.<assinatura>.ics`), para as assinaturas já
 * feitas nos celulares continuarem depois do corte. Aberto sem sessão: quem
 * tem o link vê a agenda (por isso ele pode ser trocado ou desativado).
 */
export const Route = createFileRoute("/api/calendar/apple/feed/$token")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const naoEncontrado = () => new Response("Assinatura de calendário inválida.", { status: 404, headers: { "Cache-Control": "no-store" } });
        if (!params.token.endsWith(".ics")) return naoEncontrado();
        const dono = await pessoaDoLink(params.token.slice(0, -4)).catch(() => null);
        if (!dono) return naoEncontrado();
        let corpo: string;
        try {
          corpo = await montarAgenda(dono.personId);
        } catch {
          return new Response(null, { status: 503 });
        }
        await getPool().query("SELECT app.agenda_acessada($1)", [dono.feedId]).catch(() => undefined);
        const etag = `"${createHash("sha256").update(corpo).digest("hex")}"`;
        if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, max-age=300" } });
        return new Response(corpo, {
          headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": 'inline; filename="omni.ics"',
            "Cache-Control": "private, max-age=300",
            ETag: etag,
          },
        });
      },
    },
  },
});
