/**
 * Alertas pedidos à IA no Interno/Gerencial (`@IA` ou `/alerta`, INSTRUCOES §7.6).
 *
 * 1. O pedido em português vira uma regra estruturada pelo LLM (o que vigiar nos
 *    RDOs, se é a FALTA ou a PRESENÇA da informação, quantos RDOs seguidos, quem
 *    marcar). A IA mostra como entendeu; só vale depois que quem pediu ativa.
 * 2. Cada RDO novo é lido contra a regra pelo LLM; "presente" só vale com um
 *    trecho que existe de fato no RDO (conferido aqui, como na leitura diária).
 * 3. Disparo: N RDOs seguidos sem a informação (falta) ou um RDO com ela
 *    (presença). Quem responde "veio, mas você não encontrou" ensina um exemplo.
 */

export type MarcarAlerta = "LEADER" | "PLANNER" | "FIELD_OPERATOR" | "eu";
export type RegraAlertaIA = { fonte: "rdo"; tipo: "ausencia" | "presenca"; oQue: string; dias: number; marcar: MarcarAlerta };

export const QUEM_MARCAR: Record<MarcarAlerta, string> = {
  LEADER: "líder de projetos",
  PLANNER: "gestor de contrato",
  FIELD_OPERATOR: "líder de campo",
  eu: "você",
};

/** O texto começa com @IA ou /alerta? Devolve o pedido sem o comando. */
export function comandoDeAlerta(texto: string): string | null {
  const m = texto.trim().match(/^(?:@ia|\/alerta)\b[\s:,-]*([\s\S]*)$/i);
  return m ? m[1]!.trim() : null;
}

export const VERSAO_PROMPT_ALERTA = "alerta-2026-11-05";

export const SISTEMA_ENTENDER_ALERTA = `Você transforma um pedido de alerta, escrito por alguém da Filtrovali (filtragem e flushing de óleo, limpeza química, teste de pressão) no canal de uma missão, numa regra para vigiar os RDOs (Relatórios Diários de Obra) dessa missão.

Devolva:
- "entendi": false se o pedido não for um alerta sobre o conteúdo dos RDOs (ex.: pergunta solta, pedido sobre e-mails ou WhatsApp, cobrança de prazo sem relação com o RDO). Nesse caso explique em "duvida" o que falta, em uma frase.
- "tipo": "ausencia" quando o alerta é para quando uma informação NÃO vier nos RDOs ("se não vier", "se faltar", "se não informarem"); "presenca" quando é para quando algo APARECER ("se o RDO falar em", "me avise quando citarem").
- "oQue": a informação a vigiar, curta e concreta, em português (ex.: "metros de tubulação liberados pelo cliente").
- "dias": quantos RDOs seguidos sem a informação disparam o alerta (1 a 10). Use o número pedido; sem número, 2 para "ausencia" e 1 para "presenca".
- "marcar": quem marcar quando disparar: "LEADER" (líder de projetos), "PLANNER" (gestor de contrato ou gerente do contrato), "FIELD_OPERATOR" (líder de campo, encarregado) ou "eu" (quem pediu, quando diz "me avise", "me notifique" sem citar outra pessoa). Se citar outra pessoa por cargo, use o cargo.
- "duvida": null quando entendeu.

Não invente informação que o pedido não traz.`;

export const ESQUEMA_ENTENDER_ALERTA = {
  type: "object",
  additionalProperties: false,
  required: ["entendi", "tipo", "oQue", "dias", "marcar", "duvida"],
  properties: {
    entendi: { type: "boolean" },
    tipo: { type: "string", enum: ["ausencia", "presenca"] },
    oQue: { type: "string" },
    dias: { type: "integer" },
    marcar: { type: "string", enum: ["LEADER", "PLANNER", "FIELD_OPERATOR", "eu"] },
    duvida: { type: ["string", "null"] },
  },
} as const;

/** Confere e limpa a regra devolvida pelo modelo. */
export function validarRegra(dados: unknown): { regra: RegraAlertaIA } | { duvida: string } {
  const d = (dados ?? {}) as Record<string, unknown>;
  if (d.entendi !== true) {
    return { duvida: typeof d.duvida === "string" && d.duvida.trim() ? d.duvida.trim().slice(0, 300) : "Não entendi o que vigiar nos RDOs." };
  }
  const oQue = typeof d.oQue === "string" ? d.oQue.trim().replace(/\s+/g, " ").slice(0, 200) : "";
  if (oQue.length < 3) return { duvida: "Diga qual informação devo procurar nos RDOs." };
  const tipo = d.tipo === "presenca" ? "presenca" : "ausencia";
  const dias = Math.min(10, Math.max(1, Math.round(Number(d.dias) || (tipo === "ausencia" ? 2 : 1))));
  const marcar = (["LEADER", "PLANNER", "FIELD_OPERATOR", "eu"] as const).find((m) => m === d.marcar) ?? "eu";
  return { regra: { fonte: "rdo", tipo, oQue, dias, marcar } };
}

/** Texto do cartão "entendi assim" (o canal mostra os botões Ativar/Cancelar). */
export function resumoDaRegra(regra: RegraAlertaIA, missao: string, canal: "interno" | "gerencial"): string {
  const quando =
    regra.tipo === "ausencia"
      ? `se não aparecer em ${regra.dias} RDO${regra.dias > 1 ? "s" : ""} seguido${regra.dias > 1 ? "s" : ""}`
      : "quando aparecer em um RDO";
  return [
    `Entendi. Vou criar este alerta só para a ${missao}:`,
    `• O que vigiar: nos RDOs, ${regra.tipo === "ausencia" ? "a informação de" : "menção a"} "${regra.oQue}"`,
    `• Quando avisar: ${quando}`,
    `• O que faço: marco ${QUEM_MARCAR[regra.marcar] === "você" ? "você" : `o ${QUEM_MARCAR[regra.marcar]}`} no ${canal} citando os RDOs`,
    regra.tipo === "ausencia" ? "• Se confirmarem que não veio: continuo vigiando e aviso de novo" : "• Depois de avisar: continuo vigiando os próximos RDOs",
  ].join("\n");
}

// ---------------------------------------------------------------- leitura de um RDO contra o alerta

export const SISTEMA_CONFERIR_ALERTA = `Você confere se o texto de um RDO (Relatório Diário de Obra) da Filtrovali traz uma informação específica.

Responda "presente": true só se o RDO trouxer a informação pedida (mesmo com outras palavras, abreviações ou números), e copie em "trecho" a parte EXATA do texto do RDO que a traz (até 200 caracteres, sem mudar nada). Se não trouxer, "presente": false e "trecho": null. Na dúvida, false.`;

export const ESQUEMA_CONFERIR_ALERTA = {
  type: "object",
  additionalProperties: false,
  required: ["presente", "trecho"],
  properties: { presente: { type: "boolean" }, trecho: { type: ["string", "null"] } },
} as const;

export function entradaConferirAlerta(regra: RegraAlertaIA, exemplos: string[], rdo: { data: string; texto: string }): string {
  return [
    `Informação procurada: ${regra.oQue}`,
    exemplos.length ? `Já apareceu escrita assim em outros RDOs desta missão:\n${exemplos.map((e) => `- ${e}`).join("\n")}` : "",
    `Data do RDO: ${rdo.data.split("-").reverse().join("/")}`,
    "",
    "Texto do RDO:",
    rdo.texto,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

const normalizar = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[“”"'`´]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** "presente" só com trecho que existe no RDO (o modelo não pode inventar). */
export function validarConferencia(dados: unknown, texto: string): { presente: boolean; trecho: string | null } {
  const d = (dados ?? {}) as Record<string, unknown>;
  if (d.presente !== true || typeof d.trecho !== "string") return { presente: false, trecho: null };
  const t = normalizar(d.trecho);
  if (t.length < 3 || !normalizar(texto).includes(t)) return { presente: false, trecho: null };
  return { presente: true, trecho: d.trecho.trim().slice(0, 200) };
}

// ---------------------------------------------------------------- disparo

export type Conferencia = { reportId: string; data: string; presente: boolean };

/**
 * RDOs que disparam o alerta, olhando só os conferidos desde o último disparo
 * (em ordem de data). Ausência: os últimos N seguidos sem a informação.
 * Presença: o primeiro que trouxe a informação. Nada a disparar: null.
 */
export function rdosQueDisparam(regra: RegraAlertaIA, conferencias: Conferencia[]): string[] | null {
  const ordem = [...conferencias].sort((a, b) => a.data.localeCompare(b.data) || a.reportId.localeCompare(b.reportId));
  if (regra.tipo === "presenca") {
    const achou = ordem.find((c) => c.presente);
    return achou ? [achou.reportId] : null;
  }
  let seguidos: string[] = [];
  for (const c of ordem) {
    seguidos = c.presente ? [] : [...seguidos, c.reportId];
    if (seguidos.length >= regra.dias) return seguidos.slice(-regra.dias);
  }
  return null;
}

/** Texto do disparo no canal. */
export function textoDoDisparo(regra: RegraAlertaIA, quem: string, rdos: { nome: string; data: string }[], rodada: number): string {
  const lista = rdos.map((r) => `${r.nome} (${r.data.split("-").reverse().slice(0, 2).join("/")})`).join(", ");
  const aviso = rodada > 1 ? ` (${rodada}º aviso)` : "";
  return regra.tipo === "ausencia"
    ? `${quem}, alerta da missão${aviso}: não encontrei "${regra.oQue}" ${rdos.length > 1 ? `nos ${lista}` : `no ${lista}`}. ${
        rdos.length > 1 ? `São ${rdos.length} RDOs seguidos sem essa informação.` : ""
      } Pode verificar com a equipe em campo?`.replace(/\s+/g, " ")
    : `${quem}, alerta da missão${aviso}: o ${lista} fala em "${regra.oQue}". Pode verificar?`;
}
