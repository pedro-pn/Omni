import { withPerson } from "@omni/db";
import { WhatsAppError } from "@omni/integrations/whatsapp";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../../../../server/db.ts";
import { personIdFromRequest } from "../../../../server/session.ts";
import { getWhatsApp } from "../../../../server/whatsapp.ts";

/**
 * Arquivo de uma mensagem do histórico guardado no aparelho (a mensagem não está
 * no banco do Omni): só o dono do número; o arquivo vem da Evolution do Omni e
 * nada fica guardado. Mídia muito antiga pode já ter saído do WhatsApp.
 */

const texto = (msg: string, status: number) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const nomeSeguro = (nome: string) => nome.replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "arquivo";
const EM_LINHA = /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|aac)|video\/(mp4|3gpp))$/;
const MAX_BYTES = 64 * 1024 * 1024;

export const Route = createFileRoute("/api/whatsapp/historico/$numberId/$waId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return texto("Sessão expirada. Entre de novo.", 401);
        const numero = z.uuid().safeParse(params.numberId);
        const waId = z.string().regex(/^[A-Za-z0-9]{6,128}$/).safeParse(params.waId);
        if (!numero.success || !waId.success) return texto("Arquivo inválido.", 400);
        const w = getWhatsApp();
        if (!w) return texto("O WhatsApp ainda não foi configurado no Omni.", 503);
        const [n] = await withPerson(getPool(), personId, async (db) =>
          (
            await db.execute<{ instancia: string }>(
              sql`SELECT instance_name AS instancia FROM whatsapp_numbers WHERE id = ${numero.data}::uuid AND status <> 'removido' AND app.ve_numero_whatsapp(id)`,
            )
          ).rows,
        );
        if (!n) return texto("Você não tem acesso a este arquivo.", 403);
        const pedido = new URL(request.url).searchParams.get("nome");
        try {
          const arquivo = await w.whatsapp.midia(n.instancia, waId.data);
          if (arquivo.conteudo.length > MAX_BYTES) return texto("Arquivo grande demais para abrir pelo Omni.", 413);
          const emLinha = EM_LINHA.test(arquivo.mimetype);
          const nome = nomeSeguro(pedido ?? arquivo.nome ?? "whatsapp");
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
