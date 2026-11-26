import { timingSafeEqual } from "node:crypto";

import { EvolutionClient, PonteDeAcoes, type ConfigWebhook, type WhatsApp } from "@omni/integrations/whatsapp";

import { getEnv } from "./env.ts";

/**
 * WhatsApp no servidor do Omni (só servidor): cliente da Evolution própria do
 * Omni e conferência do segredo do webhook. A chave e o segredo nunca vão
 * para o navegador nem para log.
 */

let cliente: { whatsapp: WhatsApp; webhook: ConfigWebhook } | null | undefined;

/** `null` enquanto o WhatsApp não estiver configurado (variáveis WHATSAPP_*). */
export function getWhatsApp(): { whatsapp: WhatsApp; webhook: ConfigWebhook } | null {
  if (cliente !== undefined) return cliente;
  const env = getEnv();
  if (!env.WHATSAPP_EVOLUTION_URL || !env.WHATSAPP_EVOLUTION_KEY || !env.WHATSAPP_WEBHOOK_SECRET || !env.WHATSAPP_WEBHOOK_URL) {
    cliente = null;
    return cliente;
  }
  cliente = {
    whatsapp: new EvolutionClient({ url: env.WHATSAPP_EVOLUTION_URL, chave: env.WHATSAPP_EVOLUTION_KEY }),
    webhook: { url: env.WHATSAPP_WEBHOOK_URL, segredo: env.WHATSAPP_WEBHOOK_SECRET },
  };
  return cliente;
}

let ponte: PonteDeAcoes | null | undefined;
/** Ponte de ações dentro da Evolution (agenda, contato, fixar, favoritar); null se desligada. */
export function getPonteDeAcoes(): PonteDeAcoes | null {
  if (ponte !== undefined) return ponte;
  const env = getEnv();
  ponte = env.WHATSAPP_ACOES_URL && env.WHATSAPP_ACOES_TOKEN ? new PonteDeAcoes({ url: env.WHATSAPP_ACOES_URL, token: env.WHATSAPP_ACOES_TOKEN }) : null;
  return ponte;
}

/** Compara o segredo recebido com o configurado em tempo constante. */
export function segredoDoWebhookConfere(recebido: string | null): boolean {
  const esperado = getEnv().WHATSAPP_WEBHOOK_SECRET;
  if (!esperado || !recebido) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}
