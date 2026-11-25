import type { BusinessCalendar } from "../business-calendar.ts";

/**
 * IA do ciclo da missão — sem modelo de linguagem (INSTRUCOES §7.3–7.5; PLANEJAMENTO Fase 5).
 * Cada fluxo é uma pergunta com botões, endereçada a um papel da missão (vindo
 * do filtroAPP) ou a uma função da empresa (Administração → Funções).
 * Nenhum nome de pessoa aqui.
 *
 * Cada opção declara os campos que pede, se abre desvio (e quem mais marcar),
 * as perguntas que vêm depois ("retomadas") e se encerra o ciclo no Omni.
 * O ciclo inteiro fica declarado neste arquivo.
 */

export type CampoResposta = "nova_data" | "motivo" | "detalhe";

export type Destino = { papel: "LEADER" | "PLANNER" } | { funcao: string };

export type PayloadPergunta = {
  missao: { codigo: string; titulo: string };
  dataMobilizacao?: string;
  dataDesmobilizacao?: string;
  dataCampo?: string;
  dataReferencia?: string;
  relatorio?: { id: string; tipo: string; numero: string | null; data: string };
  romaneio?: { id: string; data: string };
  /** Leitura do RDO pela IA (fluxo rdo_leitura): os pontos já como texto. */
  leitura?: { pontos: string; quantidade: number };
  /** Mensagem do grupo do WhatsApp que parece chegada (fluxo chegada_grupo). */
  chegada?: { autor: string; trecho: string; em: string };
};

export type RespostaPergunta = { opcao: string; nova_data?: string; motivo?: string; detalhe?: string; respondidoPor: string };

/** Quando a pergunta seguinte é feita. */
export type Quando =
  | { tipo: "agora" }
  | { tipo: "na_nova_data" }
  | { tipo: "uteis_antes_da_nova_data"; dias: number }
  | { tipo: "uteis_depois_da_resposta"; dias: number };

export type Retomada = {
  flow: CodigoFluxo;
  quando: Quando;
  /** Leva a nova data para este campo do payload (e para a chave, que passa a ser a da data). */
  novaDataEm?: "dataMobilizacao" | "dataDesmobilizacao";
};

export type OpcaoFluxo = {
  id: string;
  rotulo: string;
  pede?: CampoResposta[];
  /** Rótulo de cada campo no formulário. */
  rotulos?: Partial<Record<CampoResposta, string>>;
  /** Abre desvio na Qualidade com esta descrição. */
  desvio?: (payload: PayloadPergunta, resposta: RespostaPergunta) => string;
  /** Além da Qualidade e do gestor de contrato, quem marcar no aviso do desvio. */
  marcar?: Destino[];
  retomadas?: Retomada[];
  /** Encerra o ciclo da missão no Omni (a IA para de acompanhar). */
  encerraCiclo?: boolean;
  /** Cria uma tarefa para quem respondeu, no projeto da missão (prazo hoje ou a data informada). */
  tarefa?: { titulo: (payload: PayloadPergunta) => string; prazo: "hoje" | "nova_data" };
  /** Confirma a descarga do romaneio no filtroAPP (o worker envia, conforme FILTROAPP_ESCRITA). */
  descarga?: "PARCIAL" | "TOTAL";
};

export type CodigoFluxo =
  | "mob_d5"
  | "mob_d1"
  | "inicio_campo"
  | "chegada_grupo"
  | "chegada_restante"
  | "rdo_devolvido"
  | "rdo_atrasado"
  | "rdo_leitura"
  | "desmob_d1"
  | "desmob_equip"
  | "chegada_sede"
  | "medicao"
  | "aprovacao"
  | "faturamento"
  | "pagamentos"
  | "saldo_medicao"
  | "descarga";

export type FluxoIA = {
  titulo: string;
  destino: Destino;
  texto: (p: PayloadPergunta) => string;
  opcoes: OpcaoFluxo[];
};

/** "RDO nº 23", ou o número como veio quando ele já traz o tipo ("RDO 23"). */
const relatorioNome = (r: PayloadPergunta["relatorio"]) => {
  const tipo = r?.tipo ?? "relatório";
  if (!r?.numero) return tipo;
  return /^\d/.test(r.numero) ? `${tipo} nº ${r.numero}` : r.numero;
};

const br = (iso?: string) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const horaBr = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).replace(",", " às");

const complemento = (r: RespostaPergunta) =>
  [r.nova_data ? `Nova data: ${br(r.nova_data)}.` : "", r.motivo ? `Motivo: ${r.motivo}` : ""].filter(Boolean).join(" ");

const informado = (r: RespostaPergunta) => `Informado por ${r.respondidoPor} no Omni.`;

const LIDER: Destino = { papel: "LEADER" };
const MEDICAO: Destino = { funcao: "medicao" };
const FATURAMENTO: Destino = { funcao: "faturamento" };
const GERENTE_COMERCIAL: Destino = { funcao: "gerente_comercial" };

const comMotivo = (data: string) => ({ nova_data: data, motivo: "Motivo" });

export const FLUXOS_IA = {
  // ---------------------------------------------------------------- mobilização
  mob_d5: {
    titulo: "Mobilização em 5 dias úteis",
    destino: LIDER,
    texto: (p) =>
      `Faltam 5 dias úteis para a mobilização da ${p.missao.titulo} (${br(p.dataMobilizacao)}). As etapas pendentes estão encaminhadas?`,
    opcoes: [
      { id: "sim", rotulo: "Sim, estão encaminhadas" },
      {
        id: "nao",
        rotulo: "Não",
        pede: ["motivo"],
        rotulos: { motivo: "O que está pendente" },
        desvio: (p, r) =>
          `Missão ${p.missao.codigo}: risco na mobilização de ${br(p.dataMobilizacao)} — etapas pendentes não encaminhadas a 5 dias úteis. ${complemento(r)} ${informado(r)}`,
      },
    ],
  },
  mob_d1: {
    titulo: "Mobilização amanhã",
    destino: LIDER,
    texto: (p) => `A mobilização da ${p.missao.titulo} está confirmada para ${br(p.dataMobilizacao)}?`,
    opcoes: [
      { id: "sim", rotulo: "Sim, confirmada" },
      {
        id: "nao",
        rotulo: "Não",
        pede: ["nova_data", "motivo"],
        rotulos: comMotivo("Nova data de mobilização"),
        desvio: (p, r) =>
          `Missão ${p.missao.codigo}: mobilização prevista para ${br(p.dataMobilizacao)} não confirmada. ${complemento(r)} ${informado(r)}`,
        retomadas: [{ flow: "mob_d1", quando: { tipo: "uteis_antes_da_nova_data", dias: 1 }, novaDataEm: "dataMobilizacao" }],
      },
    ],
  },
  inicio_campo: {
    titulo: "Início em campo",
    destino: LIDER,
    texto: (p) => `A equipe da ${p.missao.titulo} começou a trabalhar em campo?`,
    opcoes: [
      { id: "sim", rotulo: "Sim, começou" },
      {
        id: "nao",
        rotulo: "Não",
        pede: ["nova_data", "motivo"],
        rotulos: comMotivo("Nova previsão de início"),
        desvio: (p, r) =>
          `Missão ${p.missao.codigo}: equipe não iniciou em campo após a mobilização de ${br(p.dataMobilizacao)}. ${complemento(r)} ${informado(r)}`,
        retomadas: [{ flow: "inicio_campo", quando: { tipo: "na_nova_data" } }],
      },
    ],
  },

  // Chegada da equipe percebida no grupo do WhatsApp (INSTRUCOES §7, "chegamos"; criada pelo job ia-chegadas).
  chegada_grupo: {
    titulo: "Chegada da equipe",
    destino: LIDER,
    texto: (p) =>
      // Começa com minúscula possível: a publicação junta "Destinatário, " antes do texto.
      `No grupo do WhatsApp, ${p.chegada?.autor ?? "alguém"} escreveu${p.chegada?.em ? ` (${horaBr(p.chegada.em)})` : ""}: “${p.chegada?.trecho ?? ""}”. A equipe da ${p.missao.titulo} chegou à obra?`,
    opcoes: [
      { id: "todos", rotulo: "Sim, todos chegaram" },
      {
        id: "alguns",
        rotulo: "Só alguns",
        pede: ["detalhe", "nova_data"],
        rotulos: { detalhe: "Quem ainda não chegou", nova_data: "Quando chegam" },
        retomadas: [{ flow: "chegada_restante", quando: { tipo: "na_nova_data" } }],
      },
      {
        id: "ninguem",
        rotulo: "Ainda ninguém",
        pede: ["nova_data", "motivo"],
        rotulos: comMotivo("Nova previsão de chegada"),
        desvio: (p, r) => `Missão ${p.missao.codigo}: equipe ainda não chegou à obra. ${complemento(r)} ${informado(r)}`,
        retomadas: [{ flow: "chegada_restante", quando: { tipo: "na_nova_data" } }],
      },
    ],
  },
  chegada_restante: {
    titulo: "Chegada da equipe",
    destino: LIDER,
    texto: (p) => `Hoje era a data prevista: quem faltava da equipe da ${p.missao.titulo} já chegou à obra?`,
    opcoes: [
      { id: "todos", rotulo: "Sim, todos chegaram" },
      {
        id: "nao",
        rotulo: "Ainda não",
        pede: ["nova_data", "motivo"],
        rotulos: comMotivo("Nova previsão de chegada"),
        desvio: (p, r) => `Missão ${p.missao.codigo}: parte da equipe não chegou à obra na data prevista. ${complemento(r)} ${informado(r)}`,
        retomadas: [{ flow: "chegada_restante", quando: { tipo: "na_nova_data" } }],
      },
    ],
  },

  // ---------------------------------------------------------------- execução
  rdo_devolvido: {
    titulo: "Relatório devolvido",
    destino: LIDER,
    texto: (p) =>
      `O ${relatorioNome(p.relatorio)} de ${br(p.relatorio?.data)} da ${p.missao.titulo} foi devolvido para correção. A correção já foi pedida ao líder de campo?`,
    opcoes: [
      { id: "ja_pedi", rotulo: "Já pedi a correção" },
      {
        id: "vou_cobrar",
        rotulo: "Vou cobrar agora",
        tarefa: {
          titulo: (p) => `Cobrar a correção do ${relatorioNome(p.relatorio)} de ${br(p.relatorio?.data).slice(0, 5)}`,
          prazo: "hoje",
        },
      },
    ],
  },
  rdo_atrasado: {
    titulo: "RDO não recebido",
    destino: LIDER,
    texto: (p) => `Não chegou o RDO de ${br(p.dataReferencia)} da ${p.missao.titulo}. A equipe trabalhou nesse dia?`,
    opcoes: [
      {
        id: "trabalhou",
        rotulo: "Trabalhou, vou cobrar o RDO",
        tarefa: { titulo: (p) => `Cobrar o RDO de ${br(p.dataReferencia).slice(0, 5)}`, prazo: "hoje" },
      },
      { id: "folga", rotulo: "Não era dia de trabalho" },
      {
        id: "parada",
        rotulo: "A equipe ficou parada",
        pede: ["motivo"],
        rotulos: { motivo: "Por que a equipe parou" },
        desvio: (p, r) => `Missão ${p.missao.codigo}: equipe parada em ${br(p.dataReferencia)}, sem RDO. ${complemento(r)} ${informado(r)}`,
      },
    ],
  },

  rdo_leitura: {
    titulo: "Leitura do RDO",
    destino: LIDER,
    texto: (p) =>
      `Li o ${relatorioNome(p.relatorio)} de ${br(p.relatorio?.data)} da ${p.missao.titulo} e ${
        (p.leitura?.quantidade ?? 0) > 1 ? "encontrei estes pontos" : "encontrei este ponto"
      }:\n${p.leitura?.pontos ?? ""}\nIsto precisa de ação?`,
    opcoes: [
      {
        id: "tratar",
        rotulo: "Sim, vou tratar",
        tarefa: { titulo: (p) => `Tratar o que a IA apontou no RDO de ${br(p.relatorio?.data).slice(0, 5)}`, prazo: "hoje" },
      },
      {
        id: "desvio",
        rotulo: "Sim, é um desvio",
        pede: ["motivo"],
        rotulos: { motivo: "O que aconteceu e o que foi feito" },
        desvio: (p, r) =>
          `Missão ${p.missao.codigo}: apontado na leitura do RDO de ${br(p.relatorio?.data)}.\n${p.leitura?.pontos ?? ""}\n${complemento(r)} ${informado(r)}`,
      },
      // A resposta "não" também ensina: entra na avaliação da leitura (falso alarme).
      { id: "sem_acao", rotulo: "Não, está tudo certo" },
    ],
  },

  // ---------------------------------------------------------------- desmobilização
  desmob_d1: {
    titulo: "Desmobilização amanhã",
    destino: LIDER,
    texto: (p) => `A desmobilização da ${p.missao.titulo} está confirmada para ${br(p.dataDesmobilizacao)}?`,
    opcoes: [
      { id: "total", rotulo: "Sim, total" },
      { id: "parcial", rotulo: "Sim, parcial", pede: ["detalhe"], rotulos: { detalhe: "Quem fica na obra e por quê" } },
      {
        id: "nao",
        rotulo: "Não",
        pede: ["nova_data", "motivo"],
        rotulos: comMotivo("Nova data de desmobilização"),
        desvio: (p, r) =>
          `Missão ${p.missao.codigo}: desmobilização prevista para ${br(p.dataDesmobilizacao)} não confirmada. ${complemento(r)} ${informado(r)}`,
        retomadas: [{ flow: "desmob_d1", quando: { tipo: "uteis_antes_da_nova_data", dias: 1 }, novaDataEm: "dataDesmobilizacao" }],
      },
    ],
  },
  desmob_equip: {
    titulo: "Equipamentos desmobilizados",
    destino: LIDER,
    texto: (p) => `Os equipamentos da ${p.missao.titulo} também foram desmobilizados?`,
    opcoes: [
      { id: "sim", rotulo: "Sim, todos" },
      {
        id: "nao",
        rotulo: "Ainda não",
        pede: ["nova_data", "motivo"],
        rotulos: comMotivo("Previsão para os equipamentos"),
        desvio: (p, r) => `Missão ${p.missao.codigo}: equipamentos não desmobilizados junto com a equipe. ${complemento(r)} ${informado(r)}`,
        retomadas: [{ flow: "desmob_equip", quando: { tipo: "na_nova_data" } }],
      },
    ],
  },
  chegada_sede: {
    titulo: "Chegada à sede",
    destino: LIDER,
    texto: (p) => `A equipe da ${p.missao.titulo} chegou à sede?`,
    opcoes: [
      {
        id: "sim",
        rotulo: "Sim",
        pede: ["detalhe"],
        rotulos: { detalhe: "Para onde segue cada pessoa (sede, outra missão, folga ou férias) e a partir de quando" },
      },
      {
        id: "nao",
        rotulo: "Não",
        pede: ["nova_data", "motivo"],
        rotulos: comMotivo("Nova previsão de chegada"),
        desvio: (p, r) => `Missão ${p.missao.codigo}: equipe não chegou à sede após a desmobilização. ${complemento(r)} ${informado(r)}`,
        retomadas: [{ flow: "chegada_sede", quando: { tipo: "na_nova_data" } }],
      },
    ],
  },

  // ---------------------------------------------------------------- medição, aprovação e faturamento
  medicao: {
    titulo: "Medição",
    destino: MEDICAO,
    texto: (p) => `A operação da ${p.missao.titulo} terminou em campo em ${br(p.dataCampo)}. A medição já foi feita?`,
    opcoes: [
      {
        id: "feita",
        rotulo: "Sim, já medi",
        pede: ["nova_data"],
        rotulos: { nova_data: "Previsão de aprovação pelo cliente" },
        retomadas: [{ flow: "aprovacao", quando: { tipo: "na_nova_data" } }],
      },
      {
        id: "ainda_nao",
        rotulo: "Ainda não",
        pede: ["nova_data"],
        rotulos: { nova_data: "Quando vai medir" },
        tarefa: { titulo: () => "Fazer a medição", prazo: "nova_data" },
        retomadas: [{ flow: "medicao", quando: { tipo: "na_nova_data" } }],
      },
    ],
  },
  aprovacao: {
    titulo: "Aprovação da medição",
    destino: MEDICAO,
    texto: (p) => `O cliente aprovou a medição da ${p.missao.titulo}?`,
    opcoes: [
      { id: "total", rotulo: "Sim, com o saldo completo", retomadas: [{ flow: "faturamento", quando: { tipo: "agora" } }] },
      {
        id: "outra",
        rotulo: "Sim, e haverá outra medição",
        pede: ["nova_data"],
        rotulos: { nova_data: "Data da próxima medição" },
        retomadas: [
          { flow: "faturamento", quando: { tipo: "agora" } },
          { flow: "medicao", quando: { tipo: "na_nova_data" } },
        ],
      },
      {
        id: "parcial",
        rotulo: "Sim, sem o saldo completo",
        pede: ["motivo"],
        rotulos: { motivo: "Por que não foi medido tudo e quanto ficou de fora" },
        desvio: (p, r) =>
          `Missão ${p.missao.codigo}: medição aprovada sem o saldo completo e sem nova medição prevista. ${complemento(r)} ${informado(r)}`,
        marcar: [GERENTE_COMERCIAL],
        retomadas: [{ flow: "faturamento", quando: { tipo: "agora" } }],
      },
      {
        id: "nao",
        rotulo: "Ainda não aprovou",
        pede: ["nova_data", "motivo"],
        rotulos: comMotivo("Nova previsão de aprovação"),
        desvio: (p, r) => `Missão ${p.missao.codigo}: medição ainda não aprovada pelo cliente. ${complemento(r)} ${informado(r)}`,
        retomadas: [{ flow: "aprovacao", quando: { tipo: "na_nova_data" } }],
      },
    ],
  },
  faturamento: {
    titulo: "Faturamento",
    destino: FATURAMENTO,
    texto: (p) => `A medição da ${p.missao.titulo} foi aprovada pelo cliente e está liberada para faturamento. A NF já foi emitida?`,
    opcoes: [
      {
        id: "emitida",
        rotulo: "Sim, NF emitida",
        retomadas: [{ flow: "pagamentos", quando: { tipo: "uteis_depois_da_resposta", dias: 5 } }],
      },
      {
        id: "ainda_nao",
        rotulo: "Ainda não",
        pede: ["nova_data"],
        rotulos: { nova_data: "Previsão de emissão" },
        tarefa: { titulo: () => "Emitir a NF da medição", prazo: "nova_data" },
        retomadas: [{ flow: "faturamento", quando: { tipo: "na_nova_data" } }],
      },
    ],
  },
  pagamentos: {
    titulo: "Últimos pagamentos",
    destino: FATURAMENTO,
    texto: (p) => `Ainda há despesas ou pagamentos pendentes da ${p.missao.titulo} no Omie?`,
    opcoes: [
      { id: "concluido", rotulo: "Não, está tudo fechado", encerraCiclo: true },
      {
        id: "pendente",
        rotulo: "Sim, ainda há",
        pede: ["nova_data"],
        rotulos: { nova_data: "Quando conferir de novo" },
        tarefa: { titulo: () => "Conferir despesas e pagamentos pendentes no Omie", prazo: "nova_data" },
        retomadas: [{ flow: "pagamentos", quando: { tipo: "na_nova_data" } }],
      },
    ],
  },

  // ---------------------------------------------------------------- a partir dos dados do filtroAPP (Entrega B)
  saldo_medicao: {
    titulo: "Saldo não medido",
    destino: MEDICAO,
    texto: (p) => `O filtroAPP mostra que a medição da ${p.missao.titulo} foi aprovada sem o saldo completo. Haverá outra medição?`,
    opcoes: [
      {
        id: "outra",
        rotulo: "Sim, haverá outra medição",
        pede: ["nova_data"],
        rotulos: { nova_data: "Data da próxima medição" },
        retomadas: [{ flow: "medicao", quando: { tipo: "na_nova_data" } }],
      },
      {
        id: "fora",
        rotulo: "Não, o saldo ficou de fora",
        pede: ["motivo"],
        rotulos: { motivo: "Por que o saldo ficou de fora" },
        desvio: (p, r) => `Missão ${p.missao.codigo}: medição aprovada sem o saldo completo e sem nova medição prevista. ${complemento(r)} ${informado(r)}`,
        marcar: [GERENTE_COMERCIAL],
      },
    ],
  },
  descarga: {
    titulo: "Chegada e descarga",
    destino: LIDER,
    texto: (p) => `Os equipamentos do romaneio de saída de ${br(p.romaneio?.data)} da ${p.missao.titulo} chegaram à obra e foram descarregados?`,
    opcoes: [
      { id: "total", rotulo: "Sim, tudo descarregado", descarga: "TOTAL" },
      {
        id: "parcial",
        rotulo: "Só uma parte",
        pede: ["detalhe"],
        rotulos: { detalhe: "O que chegou e o que falta" },
        descarga: "PARCIAL",
        retomadas: [{ flow: "descarga", quando: { tipo: "uteis_depois_da_resposta", dias: 1 } }],
      },
      {
        id: "ainda_nao",
        rotulo: "Ainda não chegou",
        pede: ["nova_data"],
        rotulos: { nova_data: "Nova previsão de chegada" },
        retomadas: [{ flow: "descarga", quando: { tipo: "na_nova_data" } }],
      },
    ],
  },
} satisfies Record<CodigoFluxo, FluxoIA>;

export function fluxo(codigo: string): FluxoIA | undefined {
  return (FLUXOS_IA as Record<string, FluxoIA>)[codigo];
}

/** Fluxos criados fora do planejamento da agenda (o planejador não os cancela). */
export const FLUXOS_FORA_DA_AGENDA = new Set<string>(["rdo_leitura", "chegada_grupo", "chegada_restante"]);

/**
 * Mensagem do grupo que parece chegada da equipe — o `FIELD_RX` do protótipo
 * ("chegamos", "estamos na obra", "na portaria", "onde descarrega"…), sem
 * acento e sem maiúsculas. Devolve o trecho para citar, ou null.
 */
export function trechoDeChegada(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const limpo = texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const re = /cheg(amos|uei|aram|ou|ando)\b|estamos (na|em) (obra|portaria|usina|porto)|na portaria|(onde|quem) (descarrega|recebe)/;
  if (!re.test(limpo)) return null;
  const t = texto.replace(/\s+/g, " ").trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

/** Fluxos com alguma resposta que gera outra pergunta. */
export const FLUXOS_COM_RETOMADA = Object.entries(FLUXOS_IA as Record<string, FluxoIA>)
  .filter(([, f]) => f.opcoes.some((o) => o.retomadas?.length || o.encerraCiclo))
  .map(([codigo]) => codigo);

// ---------------------------------------------------------------- planejamento a partir dos dados

export const ETAPAS_ANTES_DA_MOBILIZACAO = [
  "HANDOVER",
  "INITIAL_ANALYSIS",
  "WAITING_PLANNING",
  "MOBILIZATION_PLANNING",
  "PREPARATION",
] as const;
const ETAPAS_DESMOBILIZACAO = ["EXECUTION", "DEMOBILIZATION"];
const ETAPAS_CHEGADA = ["EXECUTION", "DEMOBILIZATION", "POST_JOB"];
const ETAPAS_MEDICAO = ["DEMOBILIZATION", "POST_JOB", "FINAL_MEASUREMENT"];

/** Fim em campo há mais tempo que isso não dispara a medição (não cobra missões antigas). */
export const JANELA_MEDICAO_DIAS = 14;
/** RDO esperado e não recebido: só os últimos dias. */
export const JANELA_RDO_DIAS = 3;

export type MissaoParaIA = {
  id: string;
  codigo: string;
  titulo: string;
  stage: string | null;
  executadaNaSede: boolean | null;
  mobilizacaoPlanejada: string | null;
  mobilizacaoComercial: string | null;
  mobilizacaoReal: string | null;
  inicioEmCampo: string | null;
  desmobilizacao?: string | null;
  fimEmCampo?: string | null;
  trabalhaSabado?: boolean | null;
  trabalhaDomingo?: boolean | null;
  /**
   * Cobrar RDO não recebido? Só quando a missão já usa RDO no filtroAPP, a cópia
   * dos relatórios está em dia e não há outra cobrança de RDO sem resposta.
   */
  cobrarRdo?: boolean;
  /** Entrega B do filtroAPP: o que ele já sabe (a IA não pergunta o que já está lá). */
  dados?: DadosFiltroApp;
  /** O líder de projetos já confirmou no Omni que a equipe toda chegou (chegada_grupo/chegada_restante). */
  chegadaConfirmada?: boolean;
};

/** Datas em YYYY-MM-DD (dia em São Paulo). */
export type DadosFiltroApp = {
  medicao: { situacao: "SEM_MEDICAO" | "PREPARADA" | "ENVIADA" | "APROVADA"; enviadaEm: string | null; aprovadaEm: string | null; saldoPendente: boolean | null } | null;
  notas: Array<{ dataEmissao: string }>;
  romaneios: Array<{ id: string; tipo: "SAIDA" | "RETORNO"; data: string; emitidoEm: string | null }>;
  descargas: Array<{ romaneioId: string; tipo: "PARCIAL" | "TOTAL" }>;
  /** null: o filtroAPP não informou; `confiavel` false: há título parcial sem saldo conhecido. */
  pendencias: { aPagar: number; aReceber: number; confiavel: boolean } | null;
};

/** Romaneio de saída emitido há mais que isso não gera pergunta de descarga (não cobra o passado). */
export const JANELA_DESCARGA_DIAS = 10;
/** Pergunta da aprovação: dias úteis depois do envio da medição ao cliente. */
export const UTEIS_ATE_COBRAR_APROVACAO = 5;

export type RelatorioParaIA = { id: string; tipo: string; numero: string | null; data: string; status: string; devolvidoEm: string | null };

export type PerguntaPlanejada = {
  flow: CodigoFluxo;
  dedupeKey: string;
  dueAt: Date;
  addressedTo: Destino;
  payload: PayloadPergunta;
  motivoData: string;
};

const dataBr = (iso: string) => iso.split("-").reverse().join("/");

/** O dia faz parte do regime da missão? Seg–sex fora de feriados; sábado e domingo se o contrato incluir. */
export function diaDoRegime(dia: string, m: Pick<MissaoParaIA, "trabalhaSabado" | "trabalhaDomingo">, cal: BusinessCalendar): boolean {
  const semana = new Date(`${dia}T12:00:00Z`).getUTCDay();
  if (semana === 6) return m.trabalhaSabado === true;
  if (semana === 0) return m.trabalhaDomingo === true;
  return cal.isBusinessDay(dia);
}

/**
 * Perguntas que os dados da missão pedem, com a data de envio já na janela útil.
 * Não cria pergunta para um dia que já passou (só para hoje ou adiante).
 * A chave de deduplicação inclui a data de referência: se a data mudar no
 * filtroAPP, nasce uma pergunta nova e a antiga é cancelada pelo worker.
 */
export function planejarPerguntas(
  missao: MissaoParaIA,
  relatorios: RelatorioParaIA[],
  cal: BusinessCalendar,
  agora: Date,
): PerguntaPlanejada[] {
  const hoje = cal.dateKeyOf(agora);
  const base: PayloadPergunta = { missao: { codigo: missao.codigo, titulo: missao.titulo } };
  const out: PerguntaPlanejada[] = [];
  // Nunca no passado: o mais tarde entre o horário no dia e agora, já ajustado à janela útil.
  const quando = (dia: string, hora: number) =>
    cal.nextSendSlot(new Date(Math.max(cal.atLocal(dia, hora).getTime(), agora.getTime())));
  const agendar = (flow: CodigoFluxo, referencia: string, dia: string, payload: PayloadPergunta, motivo: string, hora = cal.window.startHour) => {
    if (dia < hoje) return;
    out.push({
      flow,
      dedupeKey: `${flow}:${missao.id}:${referencia}`,
      dueAt: quando(dia, hora),
      addressedTo: FLUXOS_IA[flow].destino,
      payload,
      motivoData: motivo,
    });
  };
  const naSede = missao.executadaNaSede === true;

  // Mobilização
  const mobilizacao = missao.mobilizacaoPlanejada ?? missao.mobilizacaoComercial;
  const antes = (ETAPAS_ANTES_DA_MOBILIZACAO as readonly string[]).includes(missao.stage ?? "");
  if (mobilizacao && antes && !missao.mobilizacaoReal && !naSede) {
    const p = { ...base, dataMobilizacao: mobilizacao };
    agendar("mob_d5", mobilizacao, cal.previousBusinessDay(mobilizacao, 5), p, `5 dias úteis antes da mobilização (${dataBr(mobilizacao)})`);
    agendar("mob_d1", mobilizacao, cal.previousBusinessDay(mobilizacao, 1), p, `1 dia útil antes da mobilização (${dataBr(mobilizacao)})`);
  }
  const mobilizou = missao.mobilizacaoReal ?? (missao.stage === "MOBILIZATION" ? mobilizacao : null);
  if (mobilizou && !missao.inicioEmCampo && missao.stage === "MOBILIZATION" && !naSede && !missao.chegadaConfirmada) {
    agendar(
      "inicio_campo",
      mobilizou,
      cal.nextBusinessDay(mobilizou, 1),
      { ...base, dataMobilizacao: mobilizou },
      `1º dia útil após a mobilização (${dataBr(mobilizou)})`,
    );
  }

  // Execução: relatório devolvido na última semana
  const limite = new Date(agora.getTime() - 7 * 86_400_000);
  for (const r of relatorios) {
    if (r.status !== "RETURNED" || !r.devolvidoEm || new Date(r.devolvidoEm) < limite) continue;
    out.push({
      flow: "rdo_devolvido",
      dedupeKey: `rdo_devolvido:${r.id}:${r.devolvidoEm}`,
      dueAt: cal.nextSendSlot(new Date(Math.max(new Date(r.devolvidoEm).getTime(), agora.getTime()))),
      addressedTo: FLUXOS_IA.rdo_devolvido.destino,
      payload: { ...base, relatorio: { id: r.id, tipo: r.tipo, numero: r.numero, data: r.data } },
      motivoData: "Relatório devolvido no filtroAPP",
    });
  }

  // Execução: RDO de um dia do regime que não chegou (cobrado no dia útil seguinte, às 10h)
  if (missao.cobrarRdo === true && missao.stage === "EXECUTION" && missao.inicioEmCampo && !naSede) {
    const comRdo = new Set(relatorios.filter((r) => r.tipo.startsWith("RDO")).map((r) => r.data));
    for (let i = JANELA_RDO_DIAS; i >= 1; i -= 1) {
      const dia = cal.dateKeyOf(new Date(agora.getTime() - i * 86_400_000));
      if (dia < missao.inicioEmCampo || comRdo.has(dia) || !diaDoRegime(dia, missao, cal)) continue;
      agendar("rdo_atrasado", dia, cal.nextBusinessDay(dia, 1), { ...base, dataReferencia: dia }, `RDO de ${dataBr(dia)} não recebido`, 10);
    }
  }

  // Desmobilização: confirmação na véspera útil, equipamentos no fim do dia, chegada à sede no dia útil seguinte
  const desmob = missao.desmobilizacao;
  if (desmob && !naSede) {
    const p = { ...base, dataDesmobilizacao: desmob };
    if (ETAPAS_DESMOBILIZACAO.includes(missao.stage ?? "")) {
      agendar("desmob_d1", desmob, cal.previousBusinessDay(desmob, 1), p, `1 dia útil antes da desmobilização (${dataBr(desmob)})`);
      if (!retornoDesde(missao.dados, cal.previousBusinessDay(desmob, 5))) {
        agendar("desmob_equip", desmob, cal.businessDayOnOrAfter(desmob), p, `Dia da desmobilização (${dataBr(desmob)})`, 16);
      }
    }
    if (ETAPAS_CHEGADA.includes(missao.stage ?? "")) {
      agendar("chegada_sede", desmob, cal.nextBusinessDay(desmob, 1), p, `1º dia útil após a desmobilização (${dataBr(desmob)})`);
    }
  }

  // Medição: fim da operação em campo recente — só se o filtroAPP ainda não tem a medição.
  const fim = missao.fimEmCampo;
  const med = missao.dados?.medicao ?? null;
  if (
    fim &&
    ETAPAS_MEDICAO.includes(missao.stage ?? "") &&
    fim >= cal.dateKeyOf(new Date(agora.getTime() - JANELA_MEDICAO_DIAS * 86_400_000)) &&
    (!med || med.situacao === "SEM_MEDICAO")
  ) {
    const dia = cal.businessDayOnOrAfter(fim);
    agendar("medicao", fim, dia < hoje ? hoje : dia, { ...base, dataCampo: fim }, `Fim da operação em campo (${dataBr(fim)})`);
  }

  // A partir da medição registrada no filtroAPP
  if (med?.enviadaEm && !med.aprovadaEm) {
    agendar(
      "aprovacao",
      med.enviadaEm,
      cal.nextBusinessDay(med.enviadaEm, UTEIS_ATE_COBRAR_APROVACAO),
      base,
      `${UTEIS_ATE_COBRAR_APROVACAO} dias úteis após o envio da medição (${dataBr(med.enviadaEm)}, filtroAPP)`,
    );
  }
  if (med?.aprovadaEm && med.saldoPendente === true) {
    agendar("saldo_medicao", med.aprovadaEm, cal.nextBusinessDay(med.aprovadaEm, 1), base, `Medição aprovada sem o saldo completo (filtroAPP)`);
  }
  if (med?.aprovadaEm && !(missao.dados?.notas ?? []).some((n) => n.dataEmissao >= med.aprovadaEm!)) {
    agendar("faturamento", med.aprovadaEm, cal.nextBusinessDay(med.aprovadaEm, 1), base, `Medição aprovada em ${dataBr(med.aprovadaEm)} (filtroAPP), sem NF depois`);
  }

  // Chegada e descarga dos romaneios de saída recentes (filtroAPP)
  if (!naSede && ["PREPARATION", "MOBILIZATION", "EXECUTION"].includes(missao.stage ?? "")) {
    const limiteRomaneio = cal.dateKeyOf(new Date(agora.getTime() - JANELA_DESCARGA_DIAS * 86_400_000));
    for (const r of missao.dados?.romaneios ?? []) {
      if (r.tipo !== "SAIDA" || !r.emitidoEm || r.emitidoEm < limiteRomaneio) continue;
      if ((missao.dados?.descargas ?? []).some((d) => d.romaneioId === r.id && d.tipo === "TOTAL")) continue;
      // Ainda sem confirmação e dentro da janela: se o dia ideal já passou, pergunta hoje.
      const ideal = cal.nextBusinessDay(r.emitidoEm, 1);
      agendar(
        "descarga",
        r.id,
        ideal < hoje ? hoje : ideal,
        { ...base, romaneio: { id: r.id, data: r.data } },
        `Romaneio de saída emitido em ${dataBr(r.emitidoEm)} (filtroAPP)`,
        10,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- retomadas (perguntas que nascem das respostas)

export type PerguntaRespondida = {
  id: string;
  flow: string;
  missaoId: string;
  answer: { opcao?: string; nova_data?: string } | null;
  answeredAt: Date | null;
  payload: PayloadPergunta;
};

/**
 * Perguntas que as respostas pedem, conforme `retomadas` de cada opção.
 * A chave é a da resposta (pergunta + posição); quando a retomada leva a nova
 * data para o payload, a chave é a da data, a mesma que o planejamento usaria
 * se o filtroAPP mudasse a data — assim não pergunta duas vezes.
 */
const retornoDesde = (dados: DadosFiltroApp | undefined, desde: string) =>
  (dados?.romaneios ?? []).some((r) => r.tipo === "RETORNO" && r.data >= desde);

/**
 * O filtroAPP já respondeu a pergunta que uma resposta anterior agendou?
 * (`desde`: dia da resposta.) Ex.: NF emitida depois de "ainda não emiti".
 */
export function resolvidoPeloFiltroApp(flow: string, dados: DadosFiltroApp | undefined, desde: string, payload: PayloadPergunta): boolean {
  if (!dados) return false;
  switch (flow) {
    case "faturamento":
      return dados.notas.some((n) => n.dataEmissao >= desde);
    case "aprovacao":
      return Boolean(dados.medicao?.aprovadaEm && dados.medicao.aprovadaEm >= desde);
    case "desmob_equip":
      return retornoDesde(dados, desde);
    case "descarga":
      return dados.descargas.some((d) => d.romaneioId === payload.romaneio?.id && d.tipo === "TOTAL");
    case "pagamentos":
      return Boolean(dados.pendencias?.confiavel && dados.pendencias.aPagar === 0 && dados.pendencias.aReceber === 0);
    default:
      return false;
  }
}

/**
 * Encerrar o ciclo pelos dados, sem perguntar: missão em documentação/medição
 * ou encerrada, NF emitida depois do fim em campo e o Omie sem nenhuma
 * pendência (a pagar e a receber) com saldo confiável.
 */
export function cicloEncerradoPeloFiltroApp(missao: Pick<MissaoParaIA, "stage" | "fimEmCampo" | "dados">): boolean {
  const d = missao.dados;
  if (!d?.pendencias?.confiavel || d.pendencias.aPagar !== 0 || d.pendencias.aReceber !== 0) return false;
  if (!["FINAL_MEASUREMENT", "FINISHED"].includes(missao.stage ?? "")) return false;
  return d.notas.some((n) => !missao.fimEmCampo || n.dataEmissao >= missao.fimEmCampo);
}

export function planejarRetomadas(
  respondidas: PerguntaRespondida[],
  cal: BusinessCalendar,
  agora: Date,
  dadosDa: (missaoId: string) => DadosFiltroApp | undefined = () => undefined,
): PerguntaPlanejada[] {
  const hoje = cal.dateKeyOf(agora);
  const quando = (dia: string) =>
    cal.nextSendSlot(new Date(Math.max(cal.atLocal(dia, cal.window.startHour).getTime(), agora.getTime())));
  const out: PerguntaPlanejada[] = [];

  for (const r of respondidas) {
    const definicao = fluxo(r.flow);
    const opcao = definicao?.opcoes.find((o) => o.id === r.answer?.opcao);
    if (!definicao || !opcao?.retomadas) continue;
    const nova = r.answer?.nova_data && /^\d{4}-\d{2}-\d{2}$/.test(r.answer.nova_data) ? r.answer.nova_data : null;

    opcao.retomadas.forEach((ret, i) => {
      let dia: string;
      let motivo: string;
      switch (ret.quando.tipo) {
        case "agora":
          // Só logo depois da resposta; resposta antiga não gera pergunta nova.
          if (!r.answeredAt || cal.dateKeyOf(r.answeredAt) < cal.previousBusinessDay(hoje, 1)) return;
          dia = hoje;
          motivo = `Resposta "${opcao.rotulo}" em ${definicao.titulo}`;
          break;
        case "na_nova_data":
          if (!nova) return;
          dia = nova;
          motivo = `Data informada em ${definicao.titulo} (${dataBr(nova)})`;
          break;
        case "uteis_antes_da_nova_data":
          if (!nova || nova < hoje) return;
          dia = cal.previousBusinessDay(nova, ret.quando.dias);
          if (dia < hoje) dia = hoje;
          motivo = `${ret.quando.dias} dia(s) útil(eis) antes da nova data informada (${dataBr(nova)})`;
          break;
        case "uteis_depois_da_resposta":
          if (!r.answeredAt) return;
          dia = cal.nextBusinessDay(cal.dateKeyOf(r.answeredAt), ret.quando.dias);
          motivo = `${ret.quando.dias} dias úteis após "${opcao.rotulo}" em ${definicao.titulo}`;
          break;
      }
      if (dia < hoje) return;
      const respondidaEm = r.answeredAt ? cal.dateKeyOf(r.answeredAt) : hoje;
      if (resolvidoPeloFiltroApp(ret.flow, dadosDa(r.missaoId), respondidaEm, r.payload)) return;
      const levaData = Boolean(ret.novaDataEm && nova);
      out.push({
        flow: ret.flow,
        dedupeKey: levaData ? `${ret.flow}:${r.missaoId}:${nova}` : `${ret.flow}:${r.missaoId}:apos:${r.id}:${i}`,
        dueAt: ret.quando.tipo === "agora" ? cal.nextSendSlot(agora) : quando(dia),
        addressedTo: FLUXOS_IA[ret.flow].destino,
        payload: levaData ? { ...r.payload, [ret.novaDataEm!]: nova } : r.payload,
        motivoData: motivo,
      });
    });
  }
  return out;
}
