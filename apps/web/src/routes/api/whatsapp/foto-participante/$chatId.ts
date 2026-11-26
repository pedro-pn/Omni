import { schema, withPerson } from "@omni/db";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../../../../server/db.ts";
import { personIdFromRequest } from "../../../../server/session.ts";
import { getWhatsApp } from "../../../../server/whatsapp.ts";
import { fotoDoWhatsApp } from "../foto/$chatId.ts";

/**
 * Foto de quem enviou uma mensagem num grupo (como no WhatsApp Web), pelo servidor: o banco
 * confere que a pessoa vê o grupo (RLS); o endereço vem do WhatsApp pelo número do grupo e fica
 * em memória por 6 horas. Nada fica guardado no Omni.
 */

const vazio = (status: number) => new Response(null, { status, headers: { "Cache-Control": "private, max-age=3600" } });
const MAX_BYTES = 2 * 1024 * 1024;
const enderecos = new Map<string, { em: number; url: string | null }>();
const VALIDADE_MS = 6 * 3600_000;

export const Route = createFileRoute("/api/whatsapp/foto-participante/$chatId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return vazio(401);
        const id = z.uuid().safeParse(params.chatId);
        const jid = z
          .string()
          .regex(/^\d{6,20}@(s\.whatsapp\.net|lid)$/)
          .safeParse(new URL(request.url).searchParams.get("p"));
        if (!id.success || !jid.success) return vazio(400);
        const [c] = await withPerson(getPool(), personId, (db) =>
          db
            .select({ instancia: schema.whatsappNumbers.instanceName, grupo: schema.whatsappChats.isGroup })
            .from(schema.whatsappChats)
            .innerJoin(schema.whatsappNumbers, eq(schema.whatsappNumbers.id, schema.whatsappChats.numberId))
            .where(eq(schema.whatsappChats.id, id.data)),
        );
        if (!c?.grupo) return vazio(404);
        const wa = getWhatsApp();
        if (!wa) return vazio(404);
        const chave = `${c.instancia}|${jid.data}`;
        let guardado = enderecos.get(chave);
        if (!guardado || Date.now() - guardado.em > VALIDADE_MS) {
          guardado = { em: Date.now(), url: await wa.whatsapp.fotoDoPerfil(c.instancia, jid.data).catch(() => null) };
          if (enderecos.size > 5000) enderecos.delete(enderecos.keys().next().value!);
          enderecos.set(chave, guardado);
        }
        const url = fotoDoWhatsApp(guardado.url);
        if (!url) return vazio(404);
        try {
          const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8_000), headers: { accept: "image/*" } });
          const tipo = r.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
          if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(tipo)) return vazio(404);
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
