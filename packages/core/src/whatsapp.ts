/**
 * Travas do WhatsApp (ADR 0004), em código puro e testado:
 * - só uma conversa do WhatsApp origina mensagem para o WhatsApp; Interno e
 *   Gerencial nunca saem (também barrado no banco: whatsapp_outbox.origem);
 * - sem disparo em massa: limite por pessoa e por número a cada minuto.
 */

export type OrigemMensagem = "conversa" | "interno" | "gerencial" | "ia" | "email";

export function podeSairPeloWhatsApp(origem: OrigemMensagem | string): boolean {
  return origem === "conversa";
}

export const LIMITE_ENVIO_POR_MINUTO = { pessoa: 10, numero: 20 } as const;

export function dentroDoLimite(enviadasNoUltimoMinuto: { pessoa: number; numero: number }): boolean {
  return enviadasNoUltimoMinuto.pessoa < LIMITE_ENVIO_POR_MINUTO.pessoa && enviadasNoUltimoMinuto.numero < LIMITE_ENVIO_POR_MINUTO.numero;
}

/**
 * Missões citadas no nome de um grupo (número da missão com 4 ou 5 dígitos,
 * sozinho: "5851 - Oceanis", "Missão 5851", "Obra 5851/Itaporã"). Só missões
 * ativas; a pessoa confirma antes de ligar.
 */
export function missoesNoNomeDoGrupo<T extends { code: string }>(nome: string | null | undefined, missoes: T[]): T[] {
  if (!nome) return [];
  const citados = new Set(nome.match(/(?<![\d/.,-])\d{4,5}(?![\d.,]|\/\d)/g) ?? []);
  return missoes.filter((m) => citados.has(m.code));
}

