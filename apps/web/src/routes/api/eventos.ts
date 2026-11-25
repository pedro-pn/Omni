import { createFileRoute } from "@tanstack/react-router";

import { abrirEventos } from "../../server/eventos.ts";
import { personIdFromRequest } from "../../server/session.ts";

/** Eventos em tempo real (SSE) da pessoa logada. */
export const Route = createFileRoute("/api/eventos")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return new Response("Sessão expirada", { status: 401 });
        // ?receber=1: a pessoa quer receber ligações no Omni (o servidor mantém e reconecta a linha).
        return abrirEventos(personId, request.signal, { receberLigacoes: new URL(request.url).searchParams.get("receber") === "1" });
      },
    },
  },
});
