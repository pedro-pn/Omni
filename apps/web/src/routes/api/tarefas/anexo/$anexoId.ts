import { schema, withPerson } from "@omni/db";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../../../../server/db.ts";
import { registrarDownload } from "../../../../server/downloads.ts";
import { getGraph } from "../../../../server/graph.ts";
import { isSameOrigin } from "../../../../server/http.ts";
import { personIdFromRequest } from "../../../../server/session.ts";

/**
 * Abrir, baixar ou apagar um anexo de tarefa (0077): o banco confere quem vê a tarefa
 * (RLS) e o arquivo vem do SharePoint pelo servidor. Imagem, PDF, áudio e vídeo abrem no
 * navegador; o resto baixa. Apagar: só quem anexou (RLS); o arquivo sai do SharePoint.
 */

const texto = (msg: string, status: number) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const EM_LINHA = /^(image\/(jpeg|png|webp|gif)|application\/pdf|audio\/(ogg|mpeg|mp4|aac|webm)|video\/(mp4|webm))$/;
const cabecalhoNome = (nome: string) => {
  const ascii = nome.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nome)}`;
};

export const Route = createFileRoute("/api/tarefas/anexo/$anexoId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return texto("Sessão expirada. Entre de novo.", 401);
        const id = z.uuid().safeParse(params.anexoId);
        if (!id.success) return texto("Arquivo inválido.", 400);
        const [f] = await withPerson(getPool(), personId, (db) => db.select().from(schema.taskAttachments).where(eq(schema.taskAttachments.id, id.data)));
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
          if (f.mime !== "application/pdf") headers.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
          for (const h of ["Content-Length", "Content-Range"]) {
            const v = r.headers.get(h);
            if (v) headers.set(h, v);
          }
          // Miniatura de imagem carrega sozinha: só conta se pediu para baixar.
          if (!/^image\//.test(f.mime) || !emLinha) await registrarDownload(request, personId, "anexo_tarefa", f.id);
          return new Response(r.body, { status: r.status === 206 ? 206 : 200, headers });
        } catch {
          return texto("O arquivo não está disponível agora.", 502);
        }
      },
      DELETE: async ({ request, params }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return texto("Sessão expirada. Entre de novo.", 401);
        if (!isSameOrigin(request)) return texto("Origem inválida.", 403);
        const id = z.uuid().safeParse(params.anexoId);
        if (!id.success) return texto("Arquivo inválido.", 400);
        const [f] = await withPerson(getPool(), personId, (db) => db.delete(schema.taskAttachments).where(eq(schema.taskAttachments.id, id.data)).returning());
        if (!f) return texto("Só quem anexou pode apagar este arquivo.", 403);
        await getGraph()
          ?.apagarDefinitivo(f.spDriveId, f.spItemId)
          .catch((e: Error) => console.error("[tarefas] anexo apagado no Omni, mas não no SharePoint:", e.name));
        return new Response(null, { status: 204 });
      },
    },
  },
});
