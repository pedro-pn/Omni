import { addDays } from "./business-calendar.ts";

/**
 * Meta da semana como está cadastrada no filtroAPP (complemento do B6/G1): o
 * Omni não recalcula nem converte para %, só escolhe qual meta mostrar e
 * resume o que o filtroAPP já calculou. O período de contagem da meta pode não
 * ser de segunda a domingo (ex.: sexta a quinta).
 */

export type ItemMeta = {
  tipo: string; // PROGRESS | SERVICE | ATTENDANCE
  servico: string | null;
  rotuloServico: string | null;
  unidade: string;
  rotuloUnidade: string;
  base: string;
  valorCadastrado: number | null;
  planejado: number | null;
  realizado: number | null;
  diferenca: number | null;
  resultado: string; // MET | BELOW | NO_DATA | PLANNED
  pendenciasBase: string[];
  descricao: string;
};

export type MetaFiltroApp = {
  situacao: string; // PLANNED, NO_DATA, NO_RULE, BELOW, PARTIAL, ON_TARGET, ABOVE
  rotuloSituacao: string;
  emAndamento: boolean;
  periodoInicio: string;
  periodoFim: string;
  regra: string | null;
  cenario: string | null;
  atingimentoPct: number | null;
  itens: ItemMeta[];
  colaboradoresPorDia: { data: string; planejado: number | null; presentes: number | null }[];
};

/** Situações em que a meta fechada não foi cumprida. */
export const META_NAO_CUMPRIDA = ["BELOW", "PARTIAL"];

const qtd = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const ddmm = (iso: string) => iso.split("-").reverse().slice(0, 2).join("/");

export const periodoMeta = (m: MetaFiltroApp) => `${ddmm(m.periodoInicio)} a ${ddmm(m.periodoFim)}`;

/** "289,8 de 324 m" (uma linha) ou "66% da meta" (várias); senão a situação do filtroAPP. */
export function resumoMeta(m: MetaFiltroApp): string {
  const [unico] = m.itens;
  if (m.itens.length === 1 && unico && unico.planejado !== null && unico.realizado !== null) {
    const servico = unico.rotuloServico ? ` de ${unico.rotuloServico.toLowerCase()}` : "";
    return `${qtd(unico.realizado)} de ${qtd(unico.planejado)} ${unico.rotuloUnidade}${servico}`;
  }
  if (m.atingimentoPct !== null && m.situacao !== "NO_DATA") return `${Math.round(m.atingimentoPct)}% da meta`;
  return m.rotuloSituacao;
}

/** A última meta encerrada só vale para o alerta se terminou há no máximo estes dias. */
export const DIAS_META_RECENTE = 7;

/**
 * Entre as metas das semanas (qualquer ordem), a que está valendo hoje e a
 * última encerrada nos últimos DIAS_META_RECENTE dias (para o alerta: meta
 * antiga sem sucessora é ruído). Semana futura e sem regra não contam.
 */
export function escolherMetas(metas: Array<MetaFiltroApp | null | undefined>, hoje: string): { atual: MetaFiltroApp | null; ultimaFechada: MetaFiltroApp | null } {
  const validas = metas.filter((m): m is MetaFiltroApp => Boolean(m));
  const atual = validas.find((m) => m.periodoInicio <= hoje && hoje <= m.periodoFim) ?? null;
  const fechadas = validas
    .filter((m) => m.periodoFim < hoje && m.periodoFim >= addDays(hoje, -DIAS_META_RECENTE) && m.situacao !== "PLANNED" && m.situacao !== "NO_RULE")
    .sort((a, b) => b.periodoFim.localeCompare(a.periodoFim));
  return { atual, ultimaFechada: fechadas[0] ?? null };
}
