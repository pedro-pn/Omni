import { withPerson } from "@omni/db";
import { WhatsAppError } from "@omni/integrations/whatsapp";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../../../../server/db.ts";
import { personIdFromRequest } from "../../../../server/session.ts";
import { getWhatsApp } from "../../../../server/whatsapp.ts";

/**
 * Arquivo de uma mensagem do WhatsApp, pelo servidor: o banco confere quem lê
 * a conversa (app.midia_whatsapp) e o arquivo vem da Evolution do Omni. Imagem,
 * áudio e vídeo abrem no navegador; o resto baixa. Nada fica guardado no Omni.
 */

const texto = (msg: string, status: number) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const nomeSeguro = (nome: string) => nome.replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "arquivo";
const EM_LINHA = /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|aac)|video\/(mp4|3gpp))$/;
const MAX_BYTES = 64 * 1024 * 1024;

export const Route = createFileRoute("/api/whatsapp/midia/$messageId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return texto("Sessão expirada. Entre de novo.", 401);
        const id = z.uuid().safeParse(params.messageId);
        if (!id.success) return texto("Arquivo inválido.", 400);
        const w = getWhatsApp();
        if (!w) return texto("O WhatsApp ainda não foi configurado no Omni.", 503);
        const [m] = await withPerson(getPool(), personId, async (db) =>
          (await db.execute<{ instancia: string; wa_id: string; tipo: string; arquivo: string | null }>(sql`SELECT * FROM app.midia_whatsapp(${id.data}::uuid)`)).rows,
        );
        if (!m) return texto("Você não tem acesso a este arquivo.", 403);
        try {
          const arquivo = await w.whatsapp.midia(m.instancia, m.wa_id);
          if (arquivo.conteudo.length > MAX_BYTES) return texto("Arquivo grande demais para abrir pelo Omni.", 413);
          const emLinha = EM_LINHA.test(arquivo.mimetype);
          const nome = nomeSeguro(m.arquivo ?? arquivo.nome ?? `whatsapp-${m.tipo}`);
          return new Response(new Uint8Array(arquivo.conteudo), {
            headers: {
              "Content-Type": emLinha ? arquivo.mimetype : "application/octet-stream",
              "Content-Length": String(arquivo.conteudo.length),
              "Content-Disposition": `${emLinha ? "inline" : "attachment"}; filename="${nome}"; filename*=UTF-8''${encodeURIComponent(nome)}`,
              "Cache-Control": "private, max-age=300",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "sandbox; default-src 'none'",
            },
          });
        } catch (error) {
          if (error instanceof WhatsAppError && error.code === "inexistente") return texto("O arquivo não está mais disponível no WhatsApp.", 404);
          if (error instanceof WhatsAppError) return texto("Não foi possível buscar o arquivo agora.", 502);
          throw error;
        }
      },
    },
  },
});
