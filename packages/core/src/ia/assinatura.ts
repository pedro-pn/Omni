/**
 * Nome, cargo e empresa pela assinatura do e-mail (participantes da missão;
 * autorizado em 10/11/2026, consta do registro de LGPD). Só o trecho final da
 * mensagem, sem a conversa citada, vai ao modelo; cada campo devolvido precisa
 * aparecer no trecho (senão é descartado). O texto do e-mail não é guardado.
 */

export type AssinaturaExtraida = { nome: string | null; cargo: string | null; empresa: string | null; telefone: string | null };

export const VERSAO_PROMPT_ASSINATURA = "assinatura-2026-11-10";

/** Linha que abre a conversa citada (resposta ou encaminhamento). */
const CITACAO = /^(>|de:\s|from:\s|enviado:\s|sent:\s|-{2,}\s*(mensagem original|original message|forwarded message|mensagem encaminhada)|_{5,}|em .{3,120} escreveu:?$|on .{3,120} wrote:?$)/i;

/** Últimas linhas antes da conversa citada: onde fica a assinatura. */
/** O texto do próprio e-mail, sem a conversa citada (o que vem depois de "De:", "Em ... escreveu:" etc.). */
export function corpoProprio(texto: string, maxCaracteres = 20_000): string {
  const linhas: string[] = [];
  for (const bruta of texto.replace(/\r/g, "").split("\n")) {
    const l = bruta.replace(/\u00a0/g, " ").trim();
    if (CITACAO.test(l)) break;
    linhas.push(l);
  }
  return linhas.join("\n").slice(0, maxCaracteres);
}

export function trechoDaAssinatura(texto: string, maxLinhas = 15, maxCaracteres = 1200): string {
  const linhas: string[] = [];
  for (const bruta of texto.replace(/\r/g, "").split("\n")) {
    const l = bruta.replace(/ /g, " ").trim();
    if (CITACAO.test(l)) break;
    if (l) linhas.push(l);
  }
  const fim = linhas.slice(-maxLinhas).join("\n");
  return fim.length > maxCaracteres ? fim.slice(-maxCaracteres) : fim;
}

export const SISTEMA_ASSINATURA = `Você lê o final de um e-mail de trabalho e identifica a assinatura de QUEM ENVIOU.

Devolva "nome", "cargo", "empresa" e "telefone" exatamente como estão escritos no texto (copie, não reescreva nem traduza). Use null para o que não estiver na assinatura. Não use nomes de saudações ("Prezado João"), de pessoas citadas no corpo nem de avisos legais. Se não houver assinatura, devolva tudo null.`;

export const ESQUEMA_ASSINATURA = {
  type: "object",
  additionalProperties: false,
  required: ["nome", "cargo", "empresa", "telefone"],
  properties: {
    nome: { type: ["string", "null"] },
    cargo: { type: ["string", "null"] },
    empresa: { type: ["string", "null"] },
    telefone: { type: ["string", "null"] },
  },
} as const;

export const entradaAssinatura = (p: { remetente: string; nomeNoCabecalho: string | null; trecho: string }) =>
  [`Remetente: ${p.nomeNoCabecalho ? `${p.nomeNoCabecalho} <${p.remetente}>` : p.remetente}`, "", "Final do e-mail:", p.trecho].join("\n");

const normalizar = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** Confere cada campo no trecho; o que não aparece (ou é longo demais) vira null. */
export function validarAssinatura(dados: unknown, trecho: string): AssinaturaExtraida {
  const d = (dados ?? {}) as Record<string, unknown>;
  const base = normalizar(trecho);
  const digitos = trecho.replace(/\D/g, "");
  const texto = (v: unknown, max: number) => {
    if (typeof v !== "string") return null;
    const t = v.replace(/\s+/g, " ").trim();
    return t.length >= 2 && t.length <= max && base.includes(normalizar(t)) ? t : null;
  };
  const tel = typeof d.telefone === "string" ? d.telefone.trim() : "";
  const telDigitos = tel.replace(/\D/g, "");
  return {
    nome: texto(d.nome, 120),
    cargo: texto(d.cargo, 120),
    empresa: texto(d.empresa, 120),
    telefone: telDigitos.length >= 8 && telDigitos.length <= 15 && digitos.includes(telDigitos) ? tel : null,
  };
}
