import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ErroParaTela } from "../../../lib/erros.ts";
import { isSameOrigin } from "../../../server/http.ts";
import { personIdFromRequest } from "../../../server/session.ts";
import { enviarPeloWhatsApp, MAX_ARQUIVO } from "../../../server/whatsapp-envio.ts";

/** Envio de arquivo numa conversa do WhatsApp (formulário com chatId, legenda e arquivo; voz=1 para mensagem de voz). Mesmas travas do texto. */

const json = (corpo: unknown, status: number) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const nomeSeguro = (nome: string) => nome.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim().slice(0, 200) || "arquivo";

export const Route = createFileRoute("/api/whatsapp/arquivo")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return json({ erro: "Sessão expirada. Entre de novo." }, 401);
        if (!isSameOrigin(request)) return json({ erro: "Origem inválida." }, 403);
        if (Number(request.headers.get("content-length") ?? 0) > MAX_ARQUIVO + 64 * 1024) return json({ erro: "Arquivo grande demais (até 16 MB)." }, 413);
        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return json({ erro: "Envio inválido." }, 400);
        }
        const chatId = z.uuid().safeParse(form.get("chatId"));
        const legenda = z.string().max(1024).safeParse(form.get("legenda") ?? "");
        const arquivo = form.get("arquivo");
        if (!chatId.success || !legenda.success || !(arquivo instanceof File)) return json({ erro: "Envio inválido." }, 400);
        try {
          // Sem os parâmetros do tipo (ex.: "audio/webm;codecs=opus" da gravação do Chrome).
          const mimetype = (arquivo.type || "application/octet-stream").split(";")[0]!.trim().toLowerCase();
          const voz = form.get("voz") === "1";
          const r = await enviarPeloWhatsApp(personId, chatId.data, voz ? "" : legenda.data.trim(), {
            conteudo: Buffer.from(await arquivo.arrayBuffer()),
            mimetype,
            nome: nomeSeguro(voz ? `voz.${mimetype.split("/")[1]}` : arquivo.name),
            voz,
          });
          return json(r, 200);
        } catch (error) {
          if (error instanceof ErroParaTela) return json({ erro: error.message }, 400);
          console.error("[whatsapp] envio de arquivo falhou:", (error as Error).name);
          return json({ erro: "Não foi possível enviar o arquivo." }, 500);
        }
      },
    },
  },
});
