/**
 * Etapas da missão — as mesmas do workflow do filtroAPP
 * (`filtroAPP-main/shared/schemas/project-workflow.js`, PROJECT_WORKFLOW_STAGE_LABELS),
 * na ordem. O Omni só exibe; quem muda a etapa é o filtroAPP.
 */
export const ETAPAS_MISSAO = [
  ["HANDOVER", "Handover comercial"],
  ["INITIAL_ANALYSIS", "Análise inicial"],
  ["WAITING_PLANNING", "Aguardando planejamento"],
  ["MOBILIZATION_PLANNING", "Planejamento da mobilização"],
  ["PREPARATION", "Preparação"],
  ["MOBILIZATION", "Mobilização"],
  ["EXECUTION", "Em execução"],
  ["DEMOBILIZATION", "Desmobilização"],
  ["POST_JOB", "Pós-job / fechamento técnico"],
  ["FINAL_MEASUREMENT", "Documentação / medição"],
  ["FINISHED", "Encerrado"],
] as const;

export type EtapaMissao = (typeof ETAPAS_MISSAO)[number][0];

export type EtapaInfo = { codigo: EtapaMissao; posicao: number; total: number; rotulo: string };

export function etapaInfo(codigo: string | null | undefined): EtapaInfo | null {
  const index = ETAPAS_MISSAO.findIndex(([c]) => c === codigo);
  if (index < 0) return null;
  const [c, rotulo] = ETAPAS_MISSAO[index]!;
  return { codigo: c, posicao: index + 1, total: ETAPAS_MISSAO.length, rotulo };
}

/** "Etapa 7/11 · Em execução", como no protótipo. */
export function etapaResumo(codigo: string | null | undefined): string {
  const info = etapaInfo(codigo);
  return info ? `Etapa ${info.posicao}/${info.total} · ${info.rotulo}` : "Sem acompanhamento no filtroAPP";
}

/** Padrão dos grupos: "Missão 5712 - Cliente". O nome do projeto no filtroAPP é o nome curto do cliente. */
export function tituloMissao(codigo: string, nome: string): string {
  const limpo = nome.trim();
  return limpo ? `Missão ${codigo} - ${limpo}` : `Missão ${codigo}`;
}
