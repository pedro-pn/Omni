import { schema, withPerson } from "@omni/db";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../../../../server/db.ts";
import { personIdFromRequest } from "../../../../server/session.ts";

/**
 * Foto de uma conversa do WhatsApp (contato ou grupo), pelo servidor: o banco
 * confere quem vê o número (RLS) e a imagem vem do endereço que o WhatsApp
 * informou (job whatsapp-perfis). Nada fica guardado no Omni; o navegador
 * guarda por algumas horas.
 */

const vazio = (status: number) => new Response(null, { status, headers: { "Cache-Control": "private, max-age=600" } });
/** Só endereços do próprio WhatsApp (pps.whatsapp.net e afins), sempre https. */
export function fotoDoWhatsApp(url: string | null): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)whatsapp\.net$/.test(u.hostname) && !u.port && !u.username ? u : null;
  } catch {
    return null;
  }
}
const MAX_BYTES = 2 * 1024 * 1024;

export const Route = createFileRoute("/api/whatsapp/foto/$chatId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return vazio(401);
        const id = z.uuid().safeParse(params.chatId);
        if (!id.success) return vazio(400);
        const [c] = await withPerson(getPool(), personId, (db) =>
          db.select({ url: schema.whatsappChats.photoUrl }).from(schema.whatsappChats).where(eq(schema.whatsappChats.id, id.data)),
        );
        const url = fotoDoWhatsApp(c?.url ?? null);
        if (!url) return vazio(404);
        try {
          const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8_000), headers: { accept: "image/*" } });
          const tipo = r.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
          if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(tipo)) return vazio(404); // endereço vencido: o job traz um novo
          const corpo = new Uint8Array(await r.arrayBuffer());
          if (corpo.length > MAX_BYTES) return vazio(404);
          return new Response(corpo, {
            headers: {
              "Content-Type": tipo,
              "Content-Length": String(corpo.length),
              "Cache-Control": "private, max-age=21600",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "sandbox; default-src 'none'",
            },
          });
        } catch {
          return vazio(404);
        }
      },
    },
  },
});
