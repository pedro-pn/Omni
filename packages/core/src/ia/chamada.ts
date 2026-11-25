/**
 * Resumo das ligações gravadas (Fase 8): o áudio é transcrito e o LLM devolve
 * resumo, decisões e pendências no mesmo formato das reuniões do Teams
 * (`validarResumo` de ./reuniao.ts). A transcrição não é guardada; só o resumo,
 * que fica com a gravação (dono e com quem ela foi compartilhada).
 */

import { MAX_CARACTERES_TRANSCRICAO } from "./reuniao.ts";

export const VERSAO_PROMPT_CHAMADA = "chamada-2026-11-10";

export const SISTEMA_RESUMO_CHAMADA = `Você resume a transcrição de uma ligação de trabalho da Filtrovali (filtragem e flushing de óleo, limpeza química, teste de pressão em sistemas industriais), feita pelo WhatsApp entre um colaborador e um contato (cliente, fornecedor ou colega).

A transcrição é automática e não separa quem fala: deduza pelo contexto quando der; quando não der, não atribua.

Devolva:
- "resumo": de 2 a 5 frases curtas, em português, com o que foi tratado.
- "decisoes": o que ficou combinado (frases curtas). Vazio se nada foi combinado.
- "pendencias": o que alguém ficou de fazer, com "responsavel" ("Colaborador", "Contato" ou o nome dito na ligação; null se não der para saber) e "prazo" (como foi dito, ex.: "amanhã", "até sexta", ou null).

Regras: use só o que está na transcrição; não invente nomes, datas nem números. Ignore cumprimentos e conversa social. Se a transcrição for curta demais ou sem conteúdo de trabalho, diga isso no resumo e deixe as listas vazias.`;

/** Entrada do modelo: contato, sentido, data e a transcrição (cortada no limite). */
export function entradaResumoChamada(p: { contato: string; direcao: "entrada" | "saida"; data: string; minutos: number; transcricao: string }): string {
  const cortada = p.transcricao.length > MAX_CARACTERES_TRANSCRICAO;
  return [
    `Ligação ${p.direcao === "entrada" ? "recebida de" : "feita para"}: ${p.contato}`,
    `Data: ${p.data.split("-").reverse().join("/")} · duração: ${p.minutos < 1 ? "menos de 1 minuto" : `${Math.round(p.minutos)} min`}`,
    "",
    "Transcrição:",
    cortada ? `${p.transcricao.slice(0, MAX_CARACTERES_TRANSCRICAO)}\n[transcrição cortada por tamanho]` : p.transcricao,
  ].join("\n");
}
