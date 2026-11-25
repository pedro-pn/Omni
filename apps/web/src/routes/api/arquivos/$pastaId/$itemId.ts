import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ErroParaTela } from "../../../../lib/erros.ts";
import { erroDoGraph, pastaAutorizada } from "../../../../server/arquivos.ts";
import { getGraph } from "../../../../server/graph.ts";
import { personIdFromRequest } from "../../../../server/session.ts";
import { registrarDownload } from "../../../../server/downloads.ts";

/**
 * Download de um arquivo das pastas comerciais, pelo servidor: confere a
 * pessoa (app.pasta_para_leitura) e que o arquivo está dentro da pasta
 * autorizada antes de buscar no Graph. O endereço temporário do SharePoint
 * nunca chega ao navegador.
 */

const params = z.object({ pastaId: z.uuid(), itemId: z.string().regex(/^[A-Za-z0-9!_.,-]{1,300}$/) });
const texto = (msg: string, status: number) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
/** Nome seguro para o cabeçalho (sem aspas, quebras ou barras). */
const nomeSeguro = (nome: string) => nome.replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "arquivo";

export const Route = createFileRoute("/api/arquivos/$pastaId/$itemId")({
  server: {
    handlers: {
      GET: async ({ request, params: brutos }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return texto("Sessão expirada. Entre de novo.", 401);
        const p = params.safeParse(brutos);
        if (!p.success) return texto("Arquivo inválido.", 400);
        const graph = getGraph();
        if (!graph) return texto("A leitura do SharePoint ainda não foi configurada no Omni.", 503);
        try {
          const pasta = await pastaAutorizada(personId, p.data.pastaId);
          const caminho = await graph.caminhoDentro(pasta.driveId, pasta.folderId, p.data.itemId);
          if (!caminho) return texto("Este arquivo não faz parte das pastas vinculadas.", 403);
          const item = await graph.item(pasta.driveId, p.data.itemId);
          if (item.tipo !== "arquivo") return texto("Escolha um arquivo.", 400);
          const conteudo = await graph.baixar(pasta.driveId, p.data.itemId);
          const nome = nomeSeguro(item.nome);
          await registrarDownload(request, personId, "sharepoint", `${p.data.pastaId}:${p.data.itemId}`);
          return new Response(conteudo.body, {
            status: 200,
            headers: {
              "Content-Type": item.mime ?? "application/octet-stream",
              ...(conteudo.headers.get("content-length") ? { "Content-Length": conteudo.headers.get("content-length")! } : {}),
              "Content-Disposition": `attachment; filename="${nome.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(nome)}`,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "private, no-store",
            },
          });
        } catch (error) {
          if (error instanceof ErroParaTela) return texto(error.message, 403);
          try {
            erroDoGraph(error);
          } catch (e) {
            if (e instanceof ErroParaTela) return texto(e.message, 404);
          }
          console.error("[arquivos] falha no download", error instanceof Error ? error.name : "erro");
          return texto("Não foi possível baixar o arquivo agora.", 502);
        }
      },
    },
  },
});
