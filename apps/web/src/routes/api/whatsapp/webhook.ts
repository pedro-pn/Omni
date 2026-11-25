import { CABECALHO_WEBHOOK, lerEventoWebhook } from "@omni/integrations/whatsapp";
import { createFileRoute } from "@tanstack/react-router";

import { getPool } from "../../../server/db.ts";
import { segredoDoWebhookConfere } from "../../../server/whatsapp.ts";

/**
 * Webhook da Evolution própria do Omni (ADR 0004). Confere o segredo do
 * cabeçalho, lê só o necessário do corpo (lerEventoWebhook) e grava pelas
 * funções app.whatsapp_registrar_* (migration 0027), que conferem o número.
 * Nunca registra o corpo em log: ele traz a chave da instância e dados pessoais.
 */

const MAX_BYTES = 1024 * 1024;
const json = (corpo: unknown, status: number) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const Route = createFileRoute("/api/whatsapp/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!segredoDoWebhookConfere(request.headers.get(CABECALHO_WEBHOOK))) return json({ erro: "nao_autorizado" }, 401);
        const tamanho = Number(request.headers.get("content-length") ?? 0);
        if (tamanho > MAX_BYTES) return json({ erro: "grande_demais" }, 413);
        const texto = await request.text();
        if (texto.length > MAX_BYTES) return json({ erro: "grande_demais" }, 413);
        let corpo: unknown;
        try {
          corpo = JSON.parse(texto);
        } catch {
          return json({ erro: "invalido" }, 400);
        }
        const pool = getPool();
        try {
          for (const e of lerEventoWebhook(corpo)) {
            if (e.tipo === "mensagem") {
              await pool.query("SELECT app.whatsapp_registrar_mensagem($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)", [
                e.instancia, e.chatJid, e.lid, e.grupo, e.telefone, e.id, e.deMim, e.autorJid, e.autorNome, e.conteudo, e.texto, e.arquivo, e.em,
              ]);
            } else if (e.tipo === "status") {
              await pool.query("SELECT app.whatsapp_registrar_status($1, $2, $3, $4)", [e.instancia, e.chatJid, e.id, e.status]);
            } else {
              await pool.query("SELECT app.whatsapp_registrar_conexao($1, $2, $3, $4)", [e.instancia, e.estado, e.telefone, e.nomePerfil]);
            }
          }
        } catch (error) {
          // Só o código do erro: nada do corpo nem da consulta.
          console.error("[whatsapp] webhook não gravou:", (error as { code?: string }).code ?? "erro");
          return json({ erro: "indisponivel" }, 503);
        }
        return json({ ok: true }, 200);
      },
    },
  },
});
