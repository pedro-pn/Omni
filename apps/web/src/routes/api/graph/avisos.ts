import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getPool } from "../../../server/db.ts";

/**
 * Avisos do Microsoft Graph (0070): e-mail novo na Entrada de uma caixa assinada.
 * - Validação: o Graph manda `validationToken` e espera o mesmo texto de volta (texto puro).
 * - Aviso: cada item traz a assinatura e o clientState; app.graph_aviso_email confere o
 *   segredo (SHA-256 no banco) e acorda o worker, que lê a caixa pelo Graph (o corpo do aviso
 *   não é usado nem registrado). Responde 202 sempre, para o Graph não insistir.
 */

const MAX_BYTES = 256 * 1024;
const aviso = z.object({ value: z.array(z.object({ subscriptionId: z.string().max(64), clientState: z.string().max(200).nullable().optional() }).loose()).max(200) }).loose();
const aceito = () => new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });

export const Route = createFileRoute("/api/graph/avisos")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = new URL(request.url).searchParams.get("validationToken");
        if (token !== null) {
          return new Response(token.slice(0, 1024), {
            status: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
          });
        }
        if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return new Response(null, { status: 413 });
        const texto = await request.text();
        if (texto.length > MAX_BYTES) return new Response(null, { status: 413 });
        let corpo: z.infer<typeof aviso>;
        try {
          corpo = aviso.parse(JSON.parse(texto));
        } catch {
          return new Response(null, { status: 400 });
        }
        const pool = getPool();
        for (const v of corpo.value) {
          if (!v.clientState) continue;
          await pool.query("SELECT app.graph_aviso_email($1, $2)", [v.subscriptionId, v.clientState]).catch((error: { code?: string }) => {
            console.error("[graph] aviso não registrado:", error.code ?? "erro");
          });
        }
        return aceito();
      },
    },
  },
});
