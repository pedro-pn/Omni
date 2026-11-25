/**
 * Resumo de reuniões do Teams (Fases 4 e 8): a transcrição (WebVTT) vira
 * texto "Pessoa: fala" e o LLM devolve resumo, decisões e pendências em
 * formato fixo. A transcrição não é guardada; só o resumo.
 */

export type ResumoReuniao = {
  resumo: string;
  decisoes: string[];
  pendencias: { descricao: string; responsavel: string | null; prazo: string | null }[];
};

/** Quanto da transcrição vai ao modelo (o resto é cortado, com aviso no texto). */
export const MAX_CARACTERES_TRANSCRICAO = 60_000;

/** WebVTT do Teams ("<v Nome>fala</v>") em texto "Nome: fala", juntando falas seguidas da mesma pessoa. */
export function vttParaTexto(vtt: string): string {
  const linhas: { quem: string; fala: string }[] = [];
  for (const bloco of vtt.replace(/\r/g, "").split(/\n\n+/)) {
    const texto = bloco
      .split("\n")
      .filter((l) => l.trim() && !/^WEBVTT/.test(l) && !/-->/.test(l) && !/^[0-9a-f-]{8,}(\/\d+-\d+)?$/i.test(l.trim()) && !/^NOTE\b/.test(l))
      .join(" ");
    if (!texto.trim()) continue;
    const m = texto.match(/^<v ([^>]+)>([\s\S]*?)(?:<\/v>)?$/);
    const quem = (m?.[1] ?? "Participante").trim();
    const fala = (m?.[2] ?? texto).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!fala) continue;
    const ultima = linhas.at(-1);
    if (ultima && ultima.quem === quem) ultima.fala += ` ${fala}`;
    else linhas.push({ quem, fala });
  }
  return linhas.map((l) => `${l.quem}: ${l.fala}`).join("\n");
}

export const VERSAO_PROMPT_REUNIAO = "reuniao-2026-11-05";
export const SISTEMA_RESUMO_REUNIAO = `Você resume a transcrição de uma reunião de trabalho da Filtrovali (filtragem e flushing de óleo, limpeza química, teste de pressão em sistemas industriais) para a equipe interna da missão.

Devolva:
- "resumo": de 2 a 5 frases curtas, em português, com o que foi tratado.
- "decisoes": o que ficou decidido (frases curtas). Vazio se nada foi decidido.
- "pendencias": o que alguém ficou de fazer, com "responsavel" (o nome como aparece na transcrição, ou null) e "prazo" (como foi dito, ex.: "sexta", "até 10/11", ou null).

Regras: use só o que está na transcrição; não invente nomes, datas nem números. Não inclua conversa social. Valores e preços só se forem decisão da reunião.`;

export const ESQUEMA_RESUMO_REUNIAO = {
  type: "object",
  additionalProperties: false,
  required: ["resumo", "decisoes", "pendencias"],
  properties: {
    resumo: { type: "string" },
    decisoes: { type: "array", maxItems: 10, items: { type: "string" } },
    pendencias: {
      type: "array",
      maxItems: 15,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["descricao", "responsavel", "prazo"],
        properties: { descricao: { type: "string" }, responsavel: { type: ["string", "null"] }, prazo: { type: ["string", "null"] } },
      },
    },
  },
} as const;

/** Entrada do modelo: título, data e a transcrição (cortada no limite). */
export function entradaResumoReuniao(titulo: string, data: string, transcricao: string): string {
  const cortada = transcricao.length > MAX_CARACTERES_TRANSCRICAO;
  return [
    `Reunião: ${titulo}`,
    `Data: ${data.split("-").reverse().join("/")}`,
    "",
    "Transcrição:",
    cortada ? `${transcricao.slice(0, MAX_CARACTERES_TRANSCRICAO)}\n[transcrição cortada por tamanho]` : transcricao,
  ].join("\n");
}

const curta = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");

/** Confere e limpa o que o modelo devolveu (tamanhos e campos). */
export function validarResumo(dados: unknown): ResumoReuniao | null {
  if (!dados || typeof dados !== "object") return null;
  const d = dados as Record<string, unknown>;
  const resumo = curta(d.resumo, 1200);
  if (resumo.length < 10) return null;
  const decisoes = (Array.isArray(d.decisoes) ? d.decisoes : []).map((x) => curta(x, 300)).filter((x) => x.length >= 3).slice(0, 10);
  const pendencias = (Array.isArray(d.pendencias) ? d.pendencias : [])
    .map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      return { descricao: curta(o.descricao, 300), responsavel: curta(o.responsavel, 120) || null, prazo: curta(o.prazo, 60) || null };
    })
    .filter((p) => p.descricao.length >= 3)
    .slice(0, 15);
  return { resumo, decisoes, pendencias };
}

/** Texto do resumo para o Interno. */
export function textoDoResumo(titulo: string, data: string, r: ResumoReuniao): string {
  const partes = [`Resumo da reunião "${titulo}" de ${data.split("-").reverse().slice(0, 2).join("/")} (pela transcrição do Teams):`, r.resumo];
  if (r.decisoes.length) partes.push(`Decisões:\n${r.decisoes.map((x) => `• ${x}`).join("\n")}`);
  if (r.pendencias.length) {
    partes.push(
      `Pendências:\n${r.pendencias.map((p) => `• ${p.descricao}${p.responsavel ? ` — ${p.responsavel}` : ""}${p.prazo ? ` (${p.prazo})` : ""}`).join("\n")}`,
    );
  }
  partes.push("As pendências podem virar tarefa na aba Reuniões da missão.");
  return partes.join("\n\n");
}
