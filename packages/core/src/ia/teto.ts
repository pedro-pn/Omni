/**
 * Teto diário de gasto da IA (E11, pilar 10.2). O gasto do dia (horário de Brasília) é a soma de
 * `llm_calls` (tokens e chamadas, todas as finalidades). Passou do teto, nenhuma chamada sai até a
 * virada do dia; com metade do teto, quem administra é avisado antes de parar.
 *
 * Tokens são o que a OpenAI cobra (o preço muda por modelo; o teto em dinheiro fica no painel da
 * OpenAI, entrega E05). Chamadas pegam o que não tem tokens (transcrição) e laços com respostas curtas.
 */

export type UsoDaIa = { tokens: number; chamadas: number };
export type TetoDaIa = { tokens: number; chamadas: number };
export type SituacaoDoTeto = { situacao: "ok" | "metade" | "teto"; mensagem: string };

/** Uso normal em 11/2026: até 140 mil tokens num dia de carga retroativa; o teto é ~14 vezes isso. */
export const TETO_PADRAO_IA: TetoDaIa = { tokens: 2_000_000, chamadas: 3_000 };

const mil = (n: number) => Math.round(n).toLocaleString("pt-BR");

export function avaliarGastoIa(uso: UsoDaIa, teto: TetoDaIa): SituacaoDoTeto {
  const fTokens = teto.tokens > 0 ? uso.tokens / teto.tokens : 0;
  const fChamadas = teto.chamadas > 0 ? uso.chamadas / teto.chamadas : 0;
  const resumo = `${mil(uso.tokens)} de ${mil(teto.tokens)} tokens e ${mil(uso.chamadas)} de ${mil(teto.chamadas)} chamadas hoje`;
  if (fTokens >= 1 || fChamadas >= 1) {
    return { situacao: "teto", mensagem: `Teto diário da IA atingido (${resumo}). A IA fica parada até a meia-noite.` };
  }
  if (fTokens >= 0.5 || fChamadas >= 0.5) {
    return { situacao: "metade", mensagem: `A IA já usou metade do teto diário (${resumo}).` };
  }
  return { situacao: "ok", mensagem: resumo };
}
