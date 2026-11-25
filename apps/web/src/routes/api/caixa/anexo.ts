import { withPerson } from "@omni/db";
import { GraphError } from "@omni/integrations/graph";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../../../server/db.ts";
import { getGraph } from "../../../server/graph.ts";
import { personIdFromRequest } from "../../../server/session.ts";
import { registrarDownload } from "../../../server/downloads.ts";

/**
 * Anexo de um e-mail da PRÓPRIA caixa (aba E-mails): a caixa é sempre a da sessão
 * (app.minha_caixa_email), nunca vem do navegador. Ids do Graph na query (podem ter "/").
 */

const ID = /^[A-Za-z0-9_=+/-]{10,600}$/;
const texto = (msg: string, status: number) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const nomeSeguro = (nome: string) => nome.replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "anexo";

export const Route = createFileRoute("/api/caixa/anexo")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return texto("Sessão expirada. Entre de novo.", 401);
        const url = new URL(request.url);
        const p = z.object({ m: z.string().regex(ID), a: z.string().regex(ID) }).safeParse({ m: url.searchParams.get("m"), a: url.searchParams.get("a") });
        if (!p.success) return texto("Anexo inválido.", 400);
        const graph = getGraph();
        if (!graph) return texto("A leitura do Microsoft 365 ainda não foi configurada no Omni.", 503);
        const [c] = await withPerson(getPool(), personId, (db) => db.execute<{ caixa: string | null }>(sql`SELECT app.minha_caixa_email() AS caixa`)).then((r) => r.rows);
        if (!c?.caixa) return texto("Sua caixa de e-mail ainda não está conectada ao Omni.", 403);
        try {
          const m = await graph.mensagem(c.caixa, p.data.m);
          const anexo = m.anexos.find((x) => x.id === p.data.a);
          if (!anexo) return texto("Anexo não encontrado neste e-mail.", 404);
          if (!anexo.arquivo) return texto("Este anexo não é um arquivo (abra o e-mail no Outlook).", 400);
          const conteudo = await graph.anexo(c.caixa, p.data.m, anexo.id);
          const nome = nomeSeguro(anexo.nome);
          await registrarDownload(request, personId, "anexo_minha_caixa", `${p.data.m}:${anexo.id}`);
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
          if (error instanceof GraphError) return texto(error.status === 404 ? "O e-mail não está mais na caixa." : "O Microsoft 365 não respondeu agora.", error.status === 404 ? 404 : 502);
          throw error;
        }
      },
    },
  },
});
