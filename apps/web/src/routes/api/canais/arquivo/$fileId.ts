import { schema, withPerson } from "@omni/db";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../../../../server/db.ts";
import { getGraph } from "../../../../server/graph.ts";
import { personIdFromRequest } from "../../../../server/session.ts";
import { registrarDownload } from "../../../../server/downloads.ts";

/**
 * Abrir ou baixar um arquivo do Interno/Gerencial (0063): o banco confere quem lê a
 * mensagem (RLS) e o arquivo vem do SharePoint pelo servidor. Imagem, PDF, áudio e
 * vídeo abrem no navegador; o resto baixa.
 */

const texto = (msg: string, status: number) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const EM_LINHA = /^(image\/(jpeg|png|webp|gif)|application\/pdf|audio\/(ogg|mpeg|mp4|aac|webm)|video\/(mp4|webm))$/;
const cabecalhoNome = (nome: string) => {
  const ascii = nome.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nome)}`;
};

export const Route = createFileRoute("/api/canais/arquivo/$fileId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return texto("Sessão expirada. Entre de novo.", 401);
        const id = z.uuid().safeParse(params.fileId);
        if (!id.success) return texto("Arquivo inválido.", 400);
        const [f] = await withPerson(getPool(), personId, (db) => db.select().from(schema.missionMessageFiles).where(eq(schema.missionMessageFiles.id, id.data)));
        if (!f) return texto("Você não tem acesso a este arquivo.", 403);
        const graph = getGraph();
        if (!graph) return texto("O SharePoint não está configurado no Omni.", 503);
        const range = request.headers.get("Range");
        try {
          const r = await graph.baixar(f.spDriveId, f.spItemId, range ? { range } : {});
          if (!r.ok || !r.body) return texto("O arquivo não está disponível agora.", r.status === 404 ? 404 : 502);
          const emLinha = EM_LINHA.test(f.mime) && new URL(request.url).searchParams.get("baixar") !== "1";
          const headers = new Headers({
            "Content-Type": EM_LINHA.test(f.mime) ? f.mime : "application/octet-stream",
            "Content-Disposition": `${emLinha ? "inline" : "attachment"}; ${cabecalhoNome(f.name)}`,
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
            "Accept-Ranges": "bytes",
          });
          // O visualizador de PDF do navegador não abre em página isolada; o resto vai isolado.
          if (f.mime !== "application/pdf") headers.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
          for (const h of ["Content-Length", "Content-Range"]) {
            const v = r.headers.get(h);
            if (v) headers.set(h, v);
          }
          // Miniatura de imagem no canal carrega sozinha: só conta se pediu para baixar.
          if (!/^image\//.test(f.mime) || !emLinha) await registrarDownload(request, personId, "arquivo_canal", f.id);
          return new Response(r.body, { status: r.status === 206 ? 206 : 200, headers });
        } catch {
          return texto("O arquivo não está disponível agora.", 502);
        }
      },
    },
  },
});
