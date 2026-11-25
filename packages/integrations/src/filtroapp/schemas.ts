import { z } from "zod";

/**
 * Contratos da API de integrações do filtroAPP (`/api/integracoes/v1`),
 * conferidos contra produção em 28/10/2026. Campos novos do filtroAPP são
 * ignorados (z.object não-estrito); campos que somem quebram a validação de
 * propósito, para o sync parar em vez de gravar lixo.
 */

const datetime = z.iso.datetime({ offset: true });
const date = z.iso.date();

export const pageSchema = z.object({
  limit: z.number(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable().optional(),
  snapshotAt: datetime.optional(),
});

export function collectionSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: pageSchema,
    generatedAt: datetime,
    schemaVersion: z.string(),
    requestId: z.string(),
  });
}

/** GET /projetos — escopo `projetos.read`. `name` é o nome curto do cliente. */
export const projetoSchema = z.object({
  id: z.string().min(1),
  code: z.string().regex(/^\d{4}$/),
  name: z.string(),
  isActive: z.boolean(),
  location: z.string().nullable(),
  clientSegment: z.string().nullable(),
  mobilizationDate: datetime.nullable(),
  demobilizationDate: datetime.nullable(),
  startDate: datetime.nullable(),
  createdAt: datetime,
  updatedAt: datetime,
  // spec "api-omni-projetos" do filtroAPP (28/10/2026)
  clientName: z.string(),
  clientCnpj: z.string().regex(/^\d{14}$/).nullable(),
  commercialProposalCode: z.string().nullable(),
  endDate: z.union([date, datetime]).nullable(),
  includesSaturday: z.boolean(),
  includesSunday: z.boolean(),
  workdayHours: z.string(),
  weekendWorkdayHours: z.string(),
  executedAtHeadquarters: z.boolean().nullable(),
  /** Vínculo oficial com a missão do Prisma (produção); null sem vínculo. Ausente em versões antigas. */
  prisma: z
    .object({ missionId: z.string().min(1), number: z.string().nullable(), numberScope: z.string().nullable() })
    .nullable()
    .optional(),
});
export type Projeto = z.infer<typeof projetoSchema>;

/** GET /projetos/responsaveis — escopo `projetos.responsaveis.read`. */
export const responsavelSchema = z.object({
  projectId: z.string(),
  projectCode: z.string(),
  role: z.enum(["LEADER", "PLANNER", "FIELD_OPERATOR"]),
  userId: z.string().nullable(),
  collaboratorId: z.string().nullable(),
  name: z.string(),
  email: z.string().nullable(),
  updatedAt: datetime,
});
export type Responsavel = z.infer<typeof responsavelSchema>;

const statusCampos = {
  projectId: z.string(),
  projectCode: z.string(),
  workflowStarted: z.boolean(),
  stage: z.string().nullable(),
  workflowVersion: z.number().nullable(),
  plannedMobilizationDate: date.nullable(),
  plannedExecutionStartDate: date.nullable(),
  plannedExecutionEndDate: date.nullable(),
  fieldCompletionDate: date.nullable(),
  demobilizationDate: date.nullable(),
  commercialReadiness: z.string().nullable(),
  mobilizationReady: z.boolean().nullable(),
  closureReady: z.boolean().nullable(),
  openIssueCount: z.number().int(),
  criticalIssueCount: z.number().int(),
  progressPercent: z.number().nullable(),
  progressMethod: z.string().nullable(),
  closedAt: datetime.nullable(),
};

/** GET /efetivo/projetos/{id}/status — escopo `efetivo.projetos.status.read`. */
export const statusProjetoSchema = z.object({ ...statusCampos, generatedAt: datetime, schemaVersion: z.string() });
export type StatusProjeto = z.infer<typeof statusProjetoSchema>;

/** GET /efetivo/projetos/status (coleção) — mesmo escopo, com as datas comerciais. */
export const statusColecaoSchema = z.object({
  ...statusCampos,
  commercialExpectedMobilizationDate: date.nullable(),
  commercialExpectedStartDate: date.nullable(),
  commercialExpectedDurationDays: z.number().int().nullable(),
  actualMobilizationDate: date.nullable(),
});
export type StatusColecao = z.infer<typeof statusColecaoSchema>;

/** GET /eventos — escopo `eventos.read` + escopo do recurso de cada evento (spec 034). */
export const eventoSchema = z.object({
  id: z.string(),
  type: z.string(),
  occurredAt: datetime,
  projectId: z.string(),
  projectCode: z.string(),
  resource: z.string(),
  resourceId: z.string(),
});
export type Evento = z.infer<typeof eventoSchema>;

/** GET /rdo/relatorios com `rdo.relatorios.todos.read` (todos os estados). */
export const relatorioSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectCode: z.string(),
  reportType: z.string(),
  reportNumber: z.string().nullable(),
  sequenceNumber: z.number().int().nullable(),
  status: z.enum(["PENDING", "RETURNED", "APPROVED", "SIGNED"]),
  reportDate: datetime,
  daytimeWorkedMinutes: z.number().int().nullable(),
  nighttimeWorkedMinutes: z.number().int().nullable(),
  totalOvertimeMinutes: z.number().int().nullable(),
  dailyDescription: z.string().nullable(),
  overtimeReason: z.string().nullable(),
  submittedAt: datetime.nullable(),
  approvedAt: datetime.nullable(),
  returnedAt: datetime.nullable(),
  signedAt: datetime.nullable(),
  clientReleasedAt: datetime.nullable(),
  updatedAt: datetime,
  /** Spec 038 (`rdo.relatorios.pdf.download`): indicador de PDF pronto; ausente sem o escopo. */
  pdf: z
    .object({
      disponivel: z.boolean(),
      versao: z.string().nullable().optional(),
      nomeArquivo: z.string().nullable().optional(),
      atualizadoEm: datetime.nullable().optional(),
      maintenanceAttachmentIds: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
});
export type Relatorio = z.infer<typeof relatorioSchema>;

/** GET /colaboradores — `colaboradores.operacional.read`; e-mail corporativo e conta com `colaboradores.contato_corporativo.read` (spec 038). */
export const colaboradorSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  isActive: z.boolean().nullable().optional(),
  emailCorporativo: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
});
export type Colaborador = z.infer<typeof colaboradorSchema>;

/** POST /qualidade/registros — escopo `qualidade.registros.create`. */
export const novoRegistroQualidadeSchema = z.object({
  type: z.enum(["DESVIO", "INCIDENTE", "RECLAMACAO_CLIENTE"]),
  projectCode: z.string(),
  eventDate: date,
  description: z.string().min(1),
  impact: z.enum(["ALTO", "MEDIO", "BAIXO"]),
  actionOwnerEmail: z.string().email(),
  externalRef: z.object({ system: z.literal("omni"), url: z.url(), reference: z.string() }),
});
export type NovoRegistroQualidade = z.infer<typeof novoRegistroQualidadeSchema>;

export const registroCriadoSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  createdAt: datetime,
});
export type RegistroCriado = z.infer<typeof registroCriadoSchema>;

export const erroSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  requestId: z.string().optional(),
});

// ---------------------------------------------------------------- Entrega B (spec 034, contracts/delivery-b.md)

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);

/** GET /efetivo/projetos/medicoes — `efetivo.projetos.medicao.read` (+ `.valores.read` para os valores). */
export const medicaoSchema = z.object({
  projectId: z.string(),
  projectCode: z.string(),
  preparedAt: datetime.nullable(),
  sentAt: datetime.nullable(),
  approvedAt: datetime.nullable(),
  situacao: z.enum(["SEM_MEDICAO", "PREPARADA", "ENVIADA", "APROVADA"]),
  saldoPendente: z.boolean().nullable(),
  executedAmount: decimal.nullable().optional(),
  measuredAmount: decimal.nullable().optional(),
  approvedAmount: decimal.nullable().optional(),
  currency: z.string().optional(),
  updatedAt: datetime,
});
export type Medicao = z.infer<typeof medicaoSchema>;

/** GET /omie/notas — `omie.notas.read`. Só notas ligadas a um projeto. */
export const notaSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectCode: z.string(),
  tipo: z.enum(["NFSE", "NFE", "ND"]),
  numero: z.string(),
  serie: z.string().nullable(),
  dataEmissao: datetime,
  valor: decimal.nullable(),
  situacaoRecebimento: z.enum(["RECEBIDA", "PARCIAL", "EM_ABERTO", "ATRASADA", "DESCONHECIDA"]),
  updatedAt: datetime,
});
export type Nota = z.infer<typeof notaSchema>;

/** GET /romaneios — `romaneios.read` (sem motorista, placa, assinatura ou arquivos). */
export const romaneioSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectCode: z.string(),
  tipo: z.enum(["SAIDA", "RETORNO"]),
  data: datetime,
  emitidoEm: datetime.nullable(),
  quantidadeItens: z.number().int(),
  pesoCarga: decimal.nullable(),
  unidadePeso: z.string().nullable(),
  updatedAt: datetime,
});
export type Romaneio = z.infer<typeof romaneioSchema>;

const pendenciaAgregada = z.object({
  quantidade: z.number().int(),
  /** null: há título parcial sem saldo confiável (não é "quitado"). */
  valorEmAberto: decimal.nullable(),
  proximoVencimento: datetime.nullable(),
});

/** GET /omie/projetos/pendencias — `omie.pendencias.read`. Só agregado por projeto; inclui projetos zerados. */
export const pendenciaSchema = z.object({
  projectId: z.string(),
  projectCode: z.string(),
  aPagar: pendenciaAgregada,
  aReceber: pendenciaAgregada,
  atualizadoEm: datetime,
});
export type Pendencia = z.infer<typeof pendenciaSchema>;

/** GET /logistica/descargas — `logistica.descargas.read`. */
export const descargaSchema = z.object({
  id: z.string(),
  romaneioId: z.string(),
  projectId: z.string(),
  projectCode: z.string(),
  tipo: z.enum(["PARCIAL", "TOTAL"]),
  confirmadaEm: datetime,
  confirmadaPorEmail: z.string(),
  cte: z.object({ numero: z.string(), emissao: datetime.nullable(), transportadora: z.string().nullable() }).nullable(),
  updatedAt: datetime,
});
export type Descarga = z.infer<typeof descargaSchema>;

/** POST /logistica/descargas — `logistica.descargas.create` (corpo estrito). */
export const novaDescargaSchema = z.strictObject({
  romaneioId: z.string(),
  tipo: z.enum(["PARCIAL", "TOTAL"]),
  confirmadaEm: datetime,
  confirmadaPorEmail: z.string().email(),
});
export type NovaDescarga = z.infer<typeof novaDescargaSchema>;

/** GET /qualidade/registros — `qualidade.registros.read` (+ `qualidade.excluidos.read` para `includeDeleted`). Só o que o Omni usa. */
export const registroQualidadeSchema = z.object({
  id: z.string(),
  number: z.string(),
  type: z.string(),
  status: z.string(),
  impact: z.string().nullable(),
  eventDate: date.nullable(),
  project: z.object({ id: z.string(), code: z.string() }).nullable(),
  nature: z.object({ name: z.string() }).nullable(),
  actionDeadline: z.string().nullable(),
  recurrence: z.object({ recurrent: z.boolean() }).nullable(),
  deletedAt: datetime.nullable(),
  updatedAt: datetime,
});
export type RegistroQualidade = z.infer<typeof registroQualidadeSchema>;

// ---------------------------------------------------------------- Gestão (spec 034, B6)

const percentual = z.number().nullable();

/**
 * Meta da semana como está cadastrada no filtroAPP (mesma comparação do painel,
 * `buildWeeklyProgressComparison`): unidades físicas, por serviço, realizado
 * pelos RDOs. O período de contagem pode não ser de segunda a domingo.
 */
export const metaSemanaSchema = z.object({
  situacao: z.string(), // PLANNED, NO_DATA, NO_RULE, BELOW, PARTIAL, ON_TARGET, ABOVE
  rotuloSituacao: z.string(),
  emAndamento: z.boolean(),
  periodoInicio: date,
  periodoFim: date,
  regra: z.string().nullable(), // ALL | ANY
  cenario: z.string().nullable(),
  atingimentoPct: z.number().nullable(),
  itens: z.array(
    z.object({
      tipo: z.string(), // PROGRESS | SERVICE | ATTENDANCE
      servico: z.string().nullable(),
      rotuloServico: z.string().nullable(),
      unidade: z.string(),
      rotuloUnidade: z.string(),
      base: z.string(),
      valorCadastrado: z.number().nullable(),
      planejado: z.number().nullable(),
      realizado: z.number().nullable(),
      diferenca: z.number().nullable(),
      resultado: z.string(), // MET | BELOW | NO_DATA | PLANNED
      pendenciasBase: z.array(z.string()),
      descricao: z.string(),
    }),
  ),
  /** Só em metas de presença; `presentes` null = sem base (não é zero). */
  colaboradoresPorDia: z.array(z.object({ data: date, planejado: z.number().nullable(), presentes: z.number().nullable() })),
});
export type MetaSemana = z.infer<typeof metaSemanaSchema>;

/** GET /acompanhamento/projetos/semanas — `acompanhamento.progresso.read`. Uma linha por projeto e semana (segunda). */
export const semanaAcompanhamentoSchema = z.object({
  projectId: z.string(),
  projectCode: z.string(),
  weekStart: date,
  avancoInicio: percentual,
  avancoFim: percentual,
  /** Pontos percentuais planejados; null também quando a meta é estruturada sem pontos. */
  metaPontos: percentual,
  metaDefinidaPor: z.enum(["PROJETO", "GRUPO"]).nullable(),
  /** null quando a semana não tem meta. Ausente em versões antigas do filtroAPP. */
  meta: metaSemanaSchema.nullable().optional(),
  revisao: z
    .object({
      concluidaEm: datetime.nullable(),
      pendencias: z.number().int(),
      itens: z.array(z.object({ codigo: z.string(), rotulo: z.string(), ok: z.boolean() })),
    })
    .nullable(),
  updatedAt: datetime,
});
export type SemanaAcompanhamento = z.infer<typeof semanaAcompanhamentoSchema>;

/**
 * GET /acompanhamento/projetos/servicos — `acompanhamento.progresso.read` (24/11/2026).
 * Composição do avanço: os mesmos cartões do detalhe do projeto (por escopo e por
 * equipamento). `avancoTotal` é o percentual oficial (não é média dos cartões).
 * O consumidor substitui a composição do projeto a cada leitura.
 */
export const servicoDoProjetoSchema = z.object({
  escopo: z.string().nullable(),
  servico: z.string(),
  rotuloServico: z.string(),
  equipamento: z.string().nullable(),
  avancoPct: z.number().nullable(),
  unidade: z.string().nullable(),
  rotuloUnidade: z.string().nullable(),
  previsto: z.number().nullable(),
  realizado: z.number().nullable(),
  sistemas: z.number().int().nonnegative(),
});
export const servicosDoProjetoSchema = z.object({
  projectId: z.string(),
  projectCode: z.string(),
  avancoTotal: z.number().nullable(),
  servicos: z.array(servicoDoProjetoSchema),
  updatedAt: datetime,
});
export type ServicosDoProjeto = z.infer<typeof servicosDoProjetoSchema>;

/** GET /acompanhamento/projetos/custos — `acompanhamento.custos.read` (financeiro). Mesmos números do detalhe do Acompanhamento. */
export const custoProjetoSchema = z.object({
  projectId: z.string(),
  projectCode: z.string(),
  orcamento: z
    .object({
      precoVenda: decimal.nullable(),
      custoPrevisto: decimal.nullable(),
      margemPrevista: percentual,
      diasPrevistos: z.number().nullable(), // pode vir fracionário
    })
    .nullable(),
  custoRealizado: z.object({
    total: decimal,
    porCategoria: z.array(z.object({ codigo: z.string(), rotulo: z.string(), valor: decimal })),
    ate: date,
  }),
  avancoFisico: percentual,
  /** Realizado ÷ previsto, em % inteiro; null sem previsto. */
  consumoDoCusto: z.number().int().nullable(),
  currency: z.literal("BRL"),
  atualizadoEm: datetime,
});
export type CustoProjeto = z.infer<typeof custoProjetoSchema>;

/** GET /projetos/condicoes — `projetos.condicoes.read`; a diária só com `projetos.condicoes.valores.read`. */
export const condicoesSchema = z.object({
  projectId: z.string(),
  projectCode: z.string(),
  permanenciaPrevistaDias: z.number().nullable(),
  diariaStandByEquipamento: decimal.nullable().optional(),
  currency: z.literal("BRL").optional(),
  updatedAt: datetime,
});
export type Condicoes = z.infer<typeof condicoesSchema>;

/** GET /efetivo/alocacoes — `efetivo.alocacoes.read`. Sem dados pessoais: só o id do colaborador. */
export const alocacaoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectCode: z.string(),
  collaboratorId: z.string(),
  funcao: z.string().nullable(),
  mobilizacao: date.nullable(),
  desmobilizacao: date.nullable(),
  updatedAt: datetime,
  deletedAt: datetime.nullable(),
});
export type Alocacao = z.infer<typeof alocacaoSchema>;

/** GET /ponto/projetos/semanas — `ponto.resumos.read`. Só agregado; semanas com menos de 2 pessoas não vêm. */
export const pontoSemanaSchema = z.object({
  projectId: z.string(),
  projectCode: z.string(),
  weekStart: date,
  minutosNormais: z.number(),
  minutosExtra70: z.number(),
  minutosExtra100: z.number(),
  minutosNoturnos: z.number(),
  pessoas: z.number().int(),
  atualizadoEm: datetime,
});
export type PontoSemana = z.infer<typeof pontoSemanaSchema>;
