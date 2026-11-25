import type { BusinessCalendar } from "../business-calendar.ts";

/**
 * Leitura diária dos RDOs (Fase 8, IA v2). Duas partes:
 * - checagens do regime, feitas por código (certas e sem custo): trabalho em
 *   dia fora do regime e hora extra sem motivo;
 * - leitura do texto livre pelo LLM, com saída estruturada. Toda citação do
 *   modelo é conferida no texto do RDO: ponto sem citação real é descartado.
 * O resultado vira uma pergunta da IA no Interno (fluxo `rdo_leitura`).
 */

export const TIPOS_PONTO_RDO = {
  servico_adicional: "Serviço adicional ou fora do combinado",
  equipamento_parado: "Equipamento parado ou com defeito",
  falta_material: "Falta de material, insumo ou ferramenta",
  cliente_travando: "Cliente travando o serviço (liberação, acesso, documentação)",
  seguranca: "Segurança (incidente, quase acidente, condição insegura)",
  outro_risco: "Outro risco para prazo, custo ou qualidade",
  fora_do_regime: "Trabalho fora do regime contratado",
  hora_extra_sem_motivo: "Hora extra sem motivo",
} as const;
export type TipoPontoRdo = keyof typeof TIPOS_PONTO_RDO;
/** Tipos que o LLM pode devolver (os do regime são do código). */
export const TIPOS_DO_MODELO = ["servico_adicional", "equipamento_parado", "falta_material", "cliente_travando", "seguranca", "outro_risco"] as const;

export type PontoRdo = { tipo: TipoPontoRdo; resumo: string; trecho: string | null };

export type RdoParaLeitura = {
  data: string;
  texto: string;
  minutosTrabalhados: number | null;
  minutosExtras: number | null;
  motivoExtra: string | null;
};
export type RegimeMissao = { trabalhaSabado: boolean | null; trabalhaDomingo: boolean | null; jornada: string | null };

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const diaDaSemana = (dia: string) => new Date(`${dia}T12:00:00Z`).getUTCDay();
const br = (dia: string) => dia.split("-").reverse().join("/");

/** Checagens que não precisam de IA. */
export function verificarRegime(rdo: RdoParaLeitura, regime: RegimeMissao, cal: BusinessCalendar): PontoRdo[] {
  const pontos: PontoRdo[] = [];
  const dow = diaDaSemana(rdo.data);
  const trabalhou = (rdo.minutosTrabalhados ?? 0) > 0;
  if (trabalhou && dow === 6 && regime.trabalhaSabado === false) {
    pontos.push({ tipo: "fora_do_regime", resumo: `Trabalho no sábado (${br(rdo.data)}), mas o regime da missão não inclui sábado.`, trecho: null });
  } else if (trabalhou && dow === 0 && regime.trabalhaDomingo === false) {
    pontos.push({ tipo: "fora_do_regime", resumo: `Trabalho no domingo (${br(rdo.data)}), mas o regime da missão não inclui domingo.`, trecho: null });
  } else if (trabalhou && dow >= 1 && dow <= 5 && cal.holidayOn(rdo.data)) {
    pontos.push({ tipo: "fora_do_regime", resumo: `Trabalho no feriado ${cal.holidayOn(rdo.data)!.name} (${br(rdo.data)}).`, trecho: null });
  }
  if ((rdo.minutosExtras ?? 0) >= 30 && !rdo.motivoExtra?.trim()) {
    const h = Math.round(((rdo.minutosExtras ?? 0) / 60) * 10) / 10;
    pontos.push({ tipo: "hora_extra_sem_motivo", resumo: `${h.toLocaleString("pt-BR")} h de hora extra sem motivo registrado.`, trecho: null });
  }
  return pontos;
}

const normalizar = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[“”"'`´]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Filtra o que o modelo devolveu: só tipos conhecidos, com resumo, e com a
 * citação presente no texto do RDO (o modelo não pode inventar). No máximo 5.
 */
export function validarPontosDoModelo(pontos: unknown, texto: string): PontoRdo[] {
  if (!Array.isArray(pontos)) return [];
  const fonte = normalizar(texto);
  const vistos = new Set<string>();
  const ok: PontoRdo[] = [];
  for (const p of pontos) {
    if (!p || typeof p !== "object") continue;
    const { tipo, resumo, trecho } = p as Record<string, unknown>;
    if (typeof tipo !== "string" || !(TIPOS_DO_MODELO as readonly string[]).includes(tipo)) continue;
    if (typeof resumo !== "string" || resumo.trim().length < 5) continue;
    if (typeof trecho !== "string" || normalizar(trecho).length < 8 || !fonte.includes(normalizar(trecho))) continue;
    const chave = `${tipo}|${normalizar(trecho)}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    ok.push({ tipo: tipo as TipoPontoRdo, resumo: resumo.trim().slice(0, 240), trecho: trecho.trim().slice(0, 240) });
    if (ok.length === 5) break;
  }
  return ok;
}

/** Instruções do modelo (versionadas: mudou aqui, rode a avaliação). */
export const VERSAO_PROMPT_RDO = "rdo-2026-11-05b";
export const SISTEMA_LEITURA_RDO = `Você lê o Relatório Diário de Obra (RDO) de uma equipe de campo da Filtrovali (filtragem e flushing de óleo, limpeza química, teste de pressão em sistemas industriais) e aponta só o que precisa de ação da gestão.

Aponte, quando o texto disser claramente:
- servico_adicional: serviço pedido pelo cliente que parece além do combinado (ex.: "a pedido do cliente", "serviço extra", "também fizemos", novo equipamento ou sistema).
- equipamento_parado: equipamento da Filtrovali ou do cliente parado, quebrado, com defeito, aguardando peça.
- falta_material: falta de material, insumo, óleo, elemento filtrante, ferramenta ou EPI.
- cliente_travando: equipe parada esperando o cliente (liberação, permissão de trabalho, acesso, andaime, energia, documentação).
- seguranca: incidente, acidente, quase acidente ou condição insegura.
- outro_risco: outro fato que ameaça prazo, custo ou qualidade.

Regras:
- Não aponte rotina normal ("serviço executado conforme planejado", "sem ocorrências").
- Peça de reposição de um equipamento quebrado é equipamento_parado, não falta_material (aponte um ponto só).
- Clima (chuva, vento) que interrompe o serviço não é seguranca; só aponte (como outro_risco) se o texto disser que afeta o prazo.
- "trecho" deve ser uma cópia EXATA de parte do texto do RDO (sem mudar palavras), com até 200 caracteres.
- "resumo" em português, uma frase curta, dizendo o fato e por que importa.
- Na dúvida, não aponte. Sem nada a apontar, devolva "pontos": [].`;

/** Esquema da resposta (JSON Schema estrito). */
export const ESQUEMA_LEITURA_RDO = {
  type: "object",
  additionalProperties: false,
  required: ["pontos"],
  properties: {
    pontos: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tipo", "resumo", "trecho"],
        properties: {
          tipo: { type: "string", enum: [...TIPOS_DO_MODELO] },
          resumo: { type: "string" },
          trecho: { type: "string" },
        },
      },
    },
  },
} as const;

/** O que vai para o modelo: só o necessário (sem nomes de pessoas além do que estiver no texto do RDO). */
export function entradaLeituraRdo(rdo: RdoParaLeitura, regime: RegimeMissao): string {
  const dow = DIAS[diaDaSemana(rdo.data)];
  return [
    `Data do RDO: ${br(rdo.data)} (${dow}).`,
    `Regime da missão: ${regime.trabalhaSabado ? "inclui sábado" : "sem sábado"}, ${regime.trabalhaDomingo ? "inclui domingo" : "sem domingo"}${regime.jornada ? `, jornada ${regime.jornada}` : ""}.`,
    rdo.minutosExtras ? `Hora extra registrada: ${Math.round(rdo.minutosExtras / 6) / 10} h${rdo.motivoExtra ? ` (motivo: ${rdo.motivoExtra})` : ""}.` : "",
    "",
    "Texto do RDO:",
    rdo.texto,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Texto da pergunta no Interno. */
export function textoDosPontos(pontos: PontoRdo[]): string {
  return pontos.map((p) => `• ${TIPOS_PONTO_RDO[p.tipo]}: ${p.resumo}${p.trecho ? ` (“${p.trecho}”)` : ""}`).join("\n");
}
