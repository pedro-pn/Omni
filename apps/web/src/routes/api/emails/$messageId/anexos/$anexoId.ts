import { withPerson } from "@omni/db";
import { GraphError } from "@omni/integrations/graph";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../../../../../server/db.ts";
import { getGraph } from "../../../../../server/graph.ts";
import { personIdFromRequest } from "../../../../../server/session.ts";
import { registrarDownload } from "../../../../../server/downloads.ts";

/**
 * Download de um anexo de e-mail da missão, pelo servidor: o banco confere
 * quem pode e registra o acesso (app.abrir_email); o anexo é buscado no
 * Microsoft 365 pela caixa e pelo id do e-mail, nunca por endereço vindo do navegador.
 */

const params = z.object({ messageId: z.uuid(), anexoId: z.string().regex(/^[A-Za-z0-9_=+\/-]{10,600}$/) });
const texto = (msg: string, status: number) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const nomeSeguro = (nome: string) => nome.replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "anexo";

export const Route = createFileRoute("/api/emails/$messageId/anexos/$anexoId")({
  server: {
    handlers: {
      GET: async ({ request, params: brutos }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return texto("Sessão expirada. Entre de novo.", 401);
        const p = params.safeParse(brutos);
        if (!p.success) return texto("Anexo inválido.", 400);
        const graph = getGraph();
        if (!graph) return texto("A leitura do Microsoft 365 ainda não foi configurada no Omni.", 503);
        const [onde] = await withPerson(getPool(), personId, async (db) =>
          (await db.execute<{ mailbox: string; graph_id: string }>(sql`SELECT * FROM app.abrir_email(${p.data.messageId}::uuid)`)).rows,
        );
        if (!onde) return texto("Você não tem acesso a este e-mail.", 403);
        try {
          const m = await graph.mensagem(onde.mailbox, onde.graph_id);
          const anexo = m.anexos.find((a) => a.id === p.data.anexoId);
          if (!anexo) return texto("Anexo não encontrado neste e-mail.", 404);
          if (!anexo.arquivo) return texto("Este anexo não é um arquivo (abra o e-mail no Outlook).", 400);
          const conteudo = await graph.anexo(onde.mailbox, onde.graph_id, anexo.id);
          const nome = nomeSeguro(anexo.nome);
          await registrarDownload(request, personId, "anexo_email_missao", `${p.data.messageId}:${anexo.id}`);
          return new Response(conteudo.body, {
            status: 200,
            headers: {
              "Content-Type": anexo.mime ?? "application/octet-stream",
              "Content-Disposition": `attachment; filename="${nome.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(nome)}`,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "private, no-store",
            },
          });
        } catch (error) {
          if (error instanceof GraphError && error.status === 404) return texto("O e-mail ou o anexo não está mais na caixa.", 404);
          if (error instanceof GraphError && error.status === 403) return texto("O Omni perdeu o acesso a esta caixa no Microsoft 365.", 403);
          console.error("[emails] falha no download do anexo", error instanceof Error ? error.name : "erro");
          return texto("Não foi possível baixar o anexo agora.", 502);
        }
      },
    },
  },
});
