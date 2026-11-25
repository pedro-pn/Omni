import { addDays, type BusinessCalendar } from "./business-calendar.ts";
import { META_NAO_CUMPRIDA, periodoMeta, resumoMeta, type MetaFiltroApp } from "./meta-semana.ts";

/**
 * Revisão semanal (Fase 9, primeira versão): alertas de cada missão a partir
 * do que o Omni já tem (filtroAPP, Qualidade, Entrega B, Gestão/B6, IA e Tarefas).
 * Regras puras e testadas; a tela só mostra.
 */

export type MissaoRevisao = {
  stage: string | null;
  fimEmCampo: string | null;
  /** A missão já mandou algum RDO (senão não cobra RDO). */
  usaRdo: boolean;
  ultimoRdo: string | null;
  rdosDevolvidos: number;
  qualidade: { abertos: number; altoImpacto: number; acaoVencida: number };
  medicao: { situacao: "SEM_MEDICAO" | "PREPARADA" | "ENVIADA" | "APROVADA"; enviadaEm: string | null; saldoPendente: boolean | null } | null;
  notasAtrasadas: number;
  perguntasSemResposta: number;
  tarefasAtrasadas: number;
  avanco: number | null;
  avancoSemanaPassada: number | null;
  /**
   * Semana passada inteira no filtroAPP (avanço no início e no fim; meta em
   * pontos percentuais). Quando vem, substitui o histórico do Omni no "sem avanço".
   */
  semanaPassada?: { avancoInicio: number | null; avancoFim: number | null; meta: number | null } | null;
  /** Última meta encerrada, como cadastrada no filtroAPP (m, L, un, colaboradores…). Substitui a meta em p.p. */
  metaFechada?: MetaFiltroApp | null;
  /** Custos × avanço (só para gestão): % do custo previsto já gasto e avanço físico. */
  custo?: { consumo: number | null; avanco: number | null } | null;
  /**
   * Equipamento em obra: primeira saída sem retorno depois dela, e a permanência
   * prevista. Só vale com a missão em campo: o retorno quase nunca é registrado
   * em romaneio, então depois da desmobilização não dá para saber.
   */
  equipamento?: { saida: string; retornou: boolean; permanenciaPrevista: number | null; diaria: number | null } | null;
};

export type Alerta = { codigo: string; texto: string; gravidade: "alta" | "media" };

/** Dias úteis de `de` (exclusive) até `ate` (inclusive). */
export function diasUteisEntre(de: string, ate: string, cal: BusinessCalendar): number {
  let n = 0;
  let dia = de;
  while (n < 400) {
    const prox = cal.nextBusinessDay(dia, 1);
    if (prox > ate) break;
    n += 1;
    dia = prox;
  }
  return n;
}

/** Segunda-feira da semana de `dia` (semana de segunda a domingo, como no filtroAPP). */
export function segundaDaSemana(dia: string): string {
  const dow = new Date(`${dia}T12:00:00Z`).getUTCDay();
  return addDays(dia, -((dow + 6) % 7));
}

/** Dias corridos de `de` até `ate`. */
export function diasCorridos(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000);
}

const br = (iso: string) => iso.split("-").reverse().slice(0, 2).join("/");
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

export const LIMITE_DIAS_SEM_RDO = 2;
export const LIMITE_DIAS_MEDICAO = 10;
/** Custo à frente do avanço (pontos percentuais): médio acima de 15, grave acima de 30 ou além de 100% do previsto. */
export const CUSTO_FRENTE_MEDIO = 15;
export const CUSTO_FRENTE_GRAVE = 30;

const pp = (n: number) => (Math.round(n * 10) / 10).toLocaleString("pt-BR");
const reaisDia = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

export function alertasDaMissao(m: MissaoRevisao, cal: BusinessCalendar, hoje: string): Alerta[] {
  const a: Alerta[] = [];
  const posCampo = ["DEMOBILIZATION", "POST_JOB", "FINAL_MEASUREMENT"].includes(m.stage ?? "");

  if (m.stage === "EXECUTION" && m.usaRdo && (!m.ultimoRdo || diasUteisEntre(m.ultimoRdo, hoje, cal) > LIMITE_DIAS_SEM_RDO)) {
    a.push({ codigo: "sem_rdo", gravidade: "alta", texto: m.ultimoRdo ? `Sem RDO desde ${br(m.ultimoRdo)}` : "Sem RDO" });
  }
  if (m.rdosDevolvidos > 0) {
    a.push({ codigo: "rdo_devolvido", gravidade: "media", texto: `${plural(m.rdosDevolvidos, "RDO devolvido", "RDOs devolvidos")} sem correção` });
  }
  if (m.qualidade.altoImpacto > 0) {
    a.push({ codigo: "qualidade_alto", gravidade: "alta", texto: `${plural(m.qualidade.altoImpacto, "registro", "registros")} de impacto alto na Qualidade` });
  }
  if (m.qualidade.acaoVencida > 0) {
    a.push({ codigo: "qualidade_prazo", gravidade: "alta", texto: `${plural(m.qualidade.acaoVencida, "ação", "ações")} da Qualidade com prazo vencido` });
  }
  if (m.qualidade.abertos > 0 && m.qualidade.altoImpacto === 0 && m.qualidade.acaoVencida === 0) {
    a.push({ codigo: "qualidade_aberta", gravidade: "media", texto: `${plural(m.qualidade.abertos, "registro aberto", "registros abertos")} na Qualidade` });
  }
  if (posCampo && m.fimEmCampo && (!m.medicao || m.medicao.situacao === "SEM_MEDICAO" || m.medicao.situacao === "PREPARADA")) {
    const dias = diasUteisEntre(m.fimEmCampo, hoje, cal);
    if (dias > LIMITE_DIAS_MEDICAO) a.push({ codigo: "medicao_parada", gravidade: "alta", texto: `Medição não enviada (${dias} dias úteis após o fim em campo)` });
  }
  if (m.medicao?.situacao === "ENVIADA" && m.medicao.enviadaEm) {
    const dias = diasUteisEntre(m.medicao.enviadaEm, hoje, cal);
    if (dias > LIMITE_DIAS_MEDICAO) a.push({ codigo: "aprovacao_parada", gravidade: "media", texto: `Medição enviada há ${dias} dias úteis sem aprovação` });
  }
  if (m.medicao?.saldoPendente) a.push({ codigo: "saldo", gravidade: "alta", texto: "Medição aprovada sem o saldo completo" });
  if (m.notasAtrasadas > 0) {
    a.push({ codigo: "nf_atrasada", gravidade: "alta", texto: `${plural(m.notasAtrasadas, "NF", "NFs")} com recebimento atrasado` });
  }
  if (m.perguntasSemResposta > 0) {
    a.push({ codigo: "ia_sem_resposta", gravidade: "media", texto: `${plural(m.perguntasSemResposta, "pergunta", "perguntas")} do assistente sem resposta` });
  }
  if (m.tarefasAtrasadas > 0) {
    a.push({ codigo: "tarefas", gravidade: "media", texto: `${plural(m.tarefasAtrasadas, "tarefa atrasada", "tarefas atrasadas")}` });
  }
  const sp = m.semanaPassada;
  if (sp && sp.avancoInicio !== null && sp.avancoFim !== null) {
    const realizado = sp.avancoFim - sp.avancoInicio;
    // Em 100% não há mais o que avançar.
    if (m.stage === "EXECUTION" && realizado <= 0 && sp.avancoFim < 100) {
      const meta = sp.meta !== null ? `; meta ${pp(sp.meta)} p.p.` : "";
      a.push({ codigo: "sem_avanco", gravidade: "media", texto: `Sem avanço na semana passada (${Math.round(sp.avancoFim)}%${meta})` });
    } else if (sp.meta !== null && realizado < sp.meta && !m.metaFechada) {
      a.push({ codigo: "abaixo_meta", gravidade: "media", texto: `Semana passada abaixo da meta (${pp(realizado)} de ${pp(sp.meta)} p.p.)` });
    }
  } else if (m.stage === "EXECUTION" && m.avanco !== null && m.avancoSemanaPassada !== null && m.avanco <= m.avancoSemanaPassada && m.avanco < 100) {
    a.push({ codigo: "sem_avanco", gravidade: "media", texto: `Sem avanço na semana (${Math.round(m.avanco)}%)` });
  }
  if (m.custo && m.custo.consumo !== null && m.custo.avanco !== null) {
    const { consumo, avanco } = m.custo;
    const frente = consumo - avanco;
    const texto =
      consumo > 100
        ? `Custo em ${consumo}% do previsto (avanço ${Math.round(avanco)}%)`
        : `Custo em ${consumo}% do previsto com avanço de ${Math.round(avanco)}%`;
    if (consumo > 100 || frente > CUSTO_FRENTE_GRAVE) a.push({ codigo: "custo", gravidade: "alta", texto });
    else if (frente > CUSTO_FRENTE_MEDIO) a.push({ codigo: "custo", gravidade: "media", texto });
  }
  if (m.metaFechada && META_NAO_CUMPRIDA.includes(m.metaFechada.situacao)) {
    const mf = m.metaFechada;
    a.push({ codigo: "abaixo_meta", gravidade: "media", texto: `Meta de ${periodoMeta(mf)} não cumprida: ${resumoMeta(mf)}` });
  }
  const eq = m.equipamento;
  const emCampo = ["MOBILIZATION", "EXECUTION", "DEMOBILIZATION"].includes(m.stage ?? "");
  if (eq && emCampo && !eq.retornou && eq.permanenciaPrevista !== null && eq.permanenciaPrevista > 0) {
    const dias = diasCorridos(eq.saida, hoje);
    if (dias > eq.permanenciaPrevista) {
      const cobra = eq.diaria !== null && eq.diaria > 0;
      a.push({
        codigo: "equipamento",
        // Com diária de stand-by o custo já corre: grave.
        gravidade: cobra ? "alta" : "media",
        texto: `Equipamento em obra há ${dias} dias (previsto ${eq.permanenciaPrevista})${cobra ? ` · stand-by ${reaisDia(eq.diaria!)}/dia` : ""}`,
      });
    }
  }
  return a.sort((x, y) => (x.gravidade === y.gravidade ? 0 : x.gravidade === "alta" ? -1 : 1));
}
