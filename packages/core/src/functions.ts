/**
 * Funções da empresa (PLANEJAMENTO.md §4.1). A IA e os avisos endereçam
 * funções, nunca pessoas pelo nome. Quem ocupa cada função é configuração
 * (tabela `function_assignments`).
 */
export const FUNCOES = {
  qualidade: "Qualidade",
  documentacao: "Documentação",
  coordenacao_mobilizacao: "Coordenação de mobilização",
  medicao: "Medição",
  faturamento: "Faturamento",
  gerente_comercial: "Gerente comercial",
} as const;

export type FuncaoCodigo = keyof typeof FUNCOES;

/** Perfis de acesso do Omni (seção 8 do INSTRUCOES). */
export const PERFIS = {
  admin: "Administração do Omni",
  diretoria: "Diretoria",
  gerente: "Gerente",
  lider_projetos: "Líder de projetos",
  vendas: "Vendas",
  marketing: "Marketing",
  supervisor: "Supervisor",
  operacao: "Operação",
} as const;

export type PerfilCodigo = keyof typeof PERFIS;
