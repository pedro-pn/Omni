import { sql } from "drizzle-orm";
import type { MetaFiltroApp } from "@omni/core";
import {
  bigint,
  boolean,
  customType,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uuid,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Espelho tipado das tabelas criadas em `migrations/*.sql`.
 * A fonte da verdade é o SQL (inclui RLS); este arquivo só dá tipos às consultas.
 * `sessions` fica de fora de propósito: só se acessa pelas funções app.*.
 */

const citext = customType<{ data: string }>({ dataType: () => "citext" });

export const perfil = pgEnum("perfil", [
  "admin",
  "diretoria",
  "gerente",
  "lider_projetos",
  "vendas",
  "marketing",
  "supervisor",
  "operacao",
]);

export const people = pgTable("people", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  entraOid: uuid("entra_oid").unique(),
  email: citext("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  jobTitle: text("job_title"),
  phone: text("phone"),
  active: boolean("active").notNull().default(true),
  filtroappUserId: text("filtroapp_user_id"),
  /** 0045: colaborador do filtroAPP desta conta (alocação dá acesso à missão). */
  filtroappCollaboratorId: text("filtroapp_collaborator_id").unique(),
  prismaUserId: text("prisma_user_id"),
  focoUserId: uuid("foco_user_id"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // 0049: atribuída ao app "Omni" no Entra (null = nunca veio do Entra) e quem desativou.
  entraAtribuido: boolean("entra_atribuido"),
  entraSincronizadoEm: timestamp("entra_sincronizado_em", { withTimezone: true }),
  inativoPor: text("inativo_por", { enum: ["entra", "admin"] }),
});

export const personProfiles = pgTable(
  "person_profiles",
  {
    personId: uuid("person_id").notNull().references(() => people.id),
    profile: perfil("profile").notNull(),
    grantedBy: uuid("granted_by").references(() => people.id),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.profile] })],
);

export const functions = pgTable("functions", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const functionAssignments = pgTable("function_assignments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  functionCode: text("function_code").notNull().references(() => functions.code),
  personId: uuid("person_id").notNull().references(() => people.id),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on"),
  isSubstitute: boolean("is_substitute").notNull().default(false),
  createdBy: uuid("created_by").references(() => people.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const holidays = pgTable("holidays", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  date: date("date").notNull(),
  name: text("name").notNull(),
  scope: text("scope", { enum: ["municipal", "empresa"] }).notNull(),
  city: text("city"),
  createdBy: uuid("created_by").references(() => people.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actorPersonId: uuid("actor_person_id").references(() => people.id),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  requestId: text("request_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
});

/** Espelho de leitura do filtroAPP (0002). Só o worker escreve. */
export const missions = pgTable("missions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  filtroappProjectId: text("filtroapp_project_id").notNull().unique(),
  clientName: text("client_name").notNull(),
  location: text("location"),
  clientSegment: text("client_segment"),
  isActive: boolean("is_active").notNull(),
  mobilizationAt: timestamp("mobilization_at", { withTimezone: true }),
  demobilizationAt: timestamp("demobilization_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
  projectSyncedAt: timestamp("project_synced_at", { withTimezone: true }).notNull().defaultNow(),
  workflowStarted: boolean("workflow_started"),
  stage: text("stage"),
  workflowVersion: integer("workflow_version"),
  plannedMobilizationDate: date("planned_mobilization_date"),
  plannedExecutionStartDate: date("planned_execution_start_date"),
  plannedExecutionEndDate: date("planned_execution_end_date"),
  fieldCompletionDate: date("field_completion_date"),
  demobilizationDate: date("demobilization_date"),
  commercialReadiness: text("commercial_readiness"),
  mobilizationReady: boolean("mobilization_ready"),
  closureReady: boolean("closure_ready"),
  openIssueCount: integer("open_issue_count"),
  criticalIssueCount: integer("critical_issue_count"),
  progressPercent: numeric("progress_percent", { precision: 6, scale: 2, mode: "number" }),
  progressMethod: text("progress_method"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  statusSyncedAt: timestamp("status_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // 0003
  clientLegalName: text("client_legal_name"),
  clientCnpj: text("client_cnpj"),
  /** 0021: vínculo oficial com a missão do Prisma (filtroAPP). */
  prismaMissionId: text("prisma_mission_id"),
  prismaNumberScope: text("prisma_number_scope"),
  commercialProposalCode: text("commercial_proposal_code"),
  endDate: date("end_date"),
  includesSaturday: boolean("includes_saturday"),
  includesSunday: boolean("includes_sunday"),
  workdayHours: text("workday_hours"),
  weekendWorkdayHours: text("weekend_workday_hours"),
  // 0008: ciclo encerrado no Omni (a IA para de acompanhar)
  cycleClosedAt: timestamp("cycle_closed_at", { withTimezone: true }),
  executedAtHeadquarters: boolean("executed_at_headquarters"),
  commercialExpectedMobilizationDate: date("commercial_expected_mobilization_date"),
  commercialExpectedStartDate: date("commercial_expected_start_date"),
  commercialExpectedDurationDays: integer("commercial_expected_duration_days"),
  actualMobilizationDate: date("actual_mobilization_date"),
});

/** Responsáveis da missão no filtroAPP (0003). Ligação com `people` pelo e-mail, na consulta. */
export const missionResponsibles = pgTable(
  "mission_responsibles",
  {
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    role: text("role", { enum: ["LEADER", "PLANNER", "FIELD_OPERATOR"] }).notNull(),
    filtroappUserId: text("filtroapp_user_id"),
    filtroappCollaboratorId: text("filtroapp_collaborator_id"),
    name: text("name").notNull(),
    email: citext("email"),
    filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.missionId, t.role] })],
);

export const syncState = pgTable(
  "sync_state",
  {
    source: text("source").notNull(),
    resource: text("resource").notNull(),
    watermark: timestamp("watermark", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFullAt: timestamp("last_full_at", { withTimezone: true }),
    cursor: text("cursor"), // 0006: cursor opaco do feed /eventos
  },
  (t) => [primaryKey({ columns: [t.source, t.resource] })],
);

export const syncRuns = pgTable("sync_runs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  source: text("source").notNull(),
  resource: text("resource").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status", { enum: ["rodando", "ok", "erro"] }).notNull().default("rodando"),
  items: integer("items"),
  error: text("error"),
});

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

/** Credencial individual do Prisma (0004). Token cifrado pelo web; RLS: só a própria pessoa. */
export const prismaCredentials = pgTable("prisma_credentials", {
  personId: uuid("person_id").primaryKey().references(() => people.id),
  environment: text("environment", { enum: ["sandbox", "production"] }).notNull(),
  tokenCiphertext: bytea("token_ciphertext").notNull(),
  scopes: text("scopes").array().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Canais Interno e Gerencial (0005). Acesso decidido no banco por app.canal_desde(). */
export const CANAIS = ["interno", "gerencial"] as const;
export type Canal = (typeof CANAIS)[number];

export const missionMembers = pgTable(
  "mission_members",
  {
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    channel: text("channel", { enum: CANAIS }).notNull(),
    personId: uuid("person_id").notNull().references(() => people.id),
    historySince: timestamp("history_since", { withTimezone: true }),
    addedBy: uuid("added_by").notNull().references(() => people.id),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by").references(() => people.id),
  },
  (t) => [primaryKey({ columns: [t.missionId, t.channel, t.personId] })],
);

export const missionMessages = pgTable("mission_messages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  channel: text("channel", { enum: CANAIS }).notNull(),
  authorPersonId: uuid("author_person_id").references(() => people.id),
  kind: text("kind", { enum: ["texto", "sistema", "ia"] }).notNull().default("texto"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // 0031: cartão de alerta da IA (confirmação ou disparo); sem FK no espelho para evitar ciclo de tipos.
  alertId: uuid("alert_id"),
  alertFireId: uuid("alert_fire_id"),
});

/** Arquivos das mensagens do Interno/Gerencial (0063): o arquivo fica no SharePoint do Omni. */
export const missionMessageFiles = pgTable("mission_message_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id").notNull().references(() => missionMessages.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  spDriveId: text("sp_drive_id").notNull(),
  spItemId: text("sp_item_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const missionReads = pgTable(
  "mission_reads",
  {
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    channel: text("channel", { enum: CANAIS }).notNull(),
    personId: uuid("person_id").notNull().references(() => people.id),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.missionId, t.channel, t.personId] })],
);

/** Relatórios do filtroAPP (0006): RDO e técnicos, todos os estados. Só o worker escreve. */
export const reports = pgTable("reports", {
  id: text("id").primaryKey(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  reportType: text("report_type").notNull(),
  reportNumber: text("report_number"),
  sequenceNumber: integer("sequence_number"),
  status: text("status", { enum: ["PENDING", "RETURNED", "APPROVED", "SIGNED"] }).notNull(),
  reportDate: date("report_date").notNull(),
  workedMinutes: integer("worked_minutes"),
  overtimeMinutes: integer("overtime_minutes"),
  dailyDescription: text("daily_description"),
  overtimeReason: text("overtime_reason"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  returnedAt: timestamp("returned_at", { withTimezone: true }),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  clientReleasedAt: timestamp("client_released_at", { withTimezone: true }),
  filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  // 0046: PDF no filtroAPP (spec 038); null = o token ainda não tem o escopo.
  pdfDisponivel: boolean("pdf_disponivel"),
  pdfVersao: text("pdf_versao"),
  pdfNome: text("pdf_nome"),
  pdfAtualizadoEm: timestamp("pdf_atualizado_em", { withTimezone: true }),
  pdfAnexosManutencao: text("pdf_anexos_manutencao").array().notNull().default(sql`'{}'`),
});

/** Perguntas da IA (0006). */
export const aiQuestions = pgTable("ai_questions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  flow: text("flow").notNull(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  status: text("status", { enum: ["agendada", "enviada", "respondida", "cancelada"] }).notNull().default("agendada"),
  addressedTo: jsonb("addressed_to").$type<{ papel: "LEADER" | "PLANNER" } | { funcao: string }>().notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  motivoData: text("motivo_data"),
  messageId: uuid("message_id").references(() => missionMessages.id),
  answer: jsonb("answer").$type<Record<string, unknown>>(),
  answeredBy: uuid("answered_by").references(() => people.id),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Desvios abertos pela IA na Qualidade do filtroAPP (0006). */
export const aiDeviations = pgTable("ai_deviations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  questionId: uuid("question_id").notNull().unique().references(() => aiQuestions.id),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  idempotencyKey: uuid("idempotency_key").notNull().unique().default(sql`gen_random_uuid()`),
  request: jsonb("request").$type<Record<string, unknown>>().notNull(),
  status: text("status", { enum: ["pendente", "enviado", "simulado", "ensaio", "falhou"] }).notNull().default("pendente"),
  filtroappId: text("filtroapp_id"),
  filtroappNumber: text("filtroapp_number"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  createdBy: uuid("created_by").notNull().references(() => people.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

// 0008: funções que a IA endereçou na missão; quem ocupa a função vê o Interno.
export const missionFunctionAccess = pgTable(
  "mission_function_access",
  {
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    functionCode: text("function_code").notNull().references(() => functions.code),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason").notNull(),
  },
  (t) => [primaryKey({ columns: [t.missionId, t.functionCode] })],
);

// ---------------------------------------------------------------- tarefas (0009, vindas do Foco)

export const taskProjects = pgTable("task_projects", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  color: text("color").notNull().default("#1e6b4a"),
  description: text("description").notNull().default(""),
  missionId: uuid("mission_id").references(() => missions.id),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull().references(() => people.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  focoId: uuid("foco_id").unique(),
});

export const PAPEIS_PROJETO = ["owner", "manager", "member"] as const;

export const taskProjectMembers = pgTable(
  "task_project_members",
  {
    projectId: uuid("project_id").notNull().references(() => taskProjects.id),
    personId: uuid("person_id").notNull().references(() => people.id),
    role: text("role", { enum: PAPEIS_PROJETO }).notNull().default("member"),
    addedBy: uuid("added_by").references(() => people.id),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.personId] })],
);

export const taskSections = pgTable("task_sections", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id").notNull().references(() => taskProjects.id),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  focoId: uuid("foco_id").unique(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  content: text("content").notNull(),
  description: text("description").notNull().default(""),
  projectId: uuid("project_id").references(() => taskProjects.id),
  ownerPersonId: uuid("owner_person_id").references(() => people.id),
  sectionId: uuid("section_id").references(() => taskSections.id),
  parentTaskId: uuid("parent_task_id"),
  assigneePersonId: uuid("assignee_person_id").references(() => people.id),
  dueDate: date("due_date").notNull(),
  dueTime: time("due_time"),
  deadline: date("deadline"),
  durationMinutes: integer("duration_minutes"),
  priority: integer("priority").notNull().default(4),
  labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
  recurrence: text("recurrence"),
  reminderOffsetMinutes: integer("reminder_offset_minutes"),
  reminderAt: timestamp("reminder_at", { withTimezone: true }),
  reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
  position: integer("position").notNull().default(0),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: uuid("completed_by").references(() => people.id),
  createdBy: uuid("created_by").notNull().references(() => people.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  focoId: uuid("foco_id").unique(),
});

// 0010: comentários e histórico das tarefas (o histórico só o trigger escreve).
export const taskComments = pgTable("task_comments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: uuid("task_id").notNull().references(() => tasks.id),
  authorPersonId: uuid("author_person_id").notNull().references(() => people.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  focoId: uuid("foco_id").unique(),
});

/** Reações nos comentários (0036), os mesmos emojis do Foco. */
export const EMOJIS_REACAO = ["👍", "❤️", "😂", "🎉", "😮", "😢"] as const;
export const taskCommentReactions = pgTable(
  "task_comment_reactions",
  {
    commentId: uuid("comment_id").notNull().references(() => taskComments.id),
    personId: uuid("person_id").notNull().references(() => people.id),
    emoji: text("emoji", { enum: EMOJIS_REACAO }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.personId, t.emoji] })],
);

/** Filtros salvos por pessoa (0037), linguagem do Foco (`@omni/core` tarefaCombinaComFiltro). */
export const taskSavedFilters = pgTable("task_saved_filters", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  personId: uuid("person_id").notNull().references(() => people.id),
  name: text("name").notNull(),
  query: text("query").notNull(),
  color: text("color").notNull().default("#6b7280"),
  favorite: boolean("favorite").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  focoId: uuid("foco_id").unique(),
});

/** Link privado da agenda (.ics) por pessoa (0041), compatível com os links do Foco. */
export const calendarFeeds = pgTable("calendar_feeds", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  personId: uuid("person_id").notNull().unique().references(() => people.id),
  signedSubject: text("signed_subject").notNull(),
  signedCreated: text("signed_created").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
});

export const taskActivity = pgTable("task_activity", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: uuid("task_id").notNull().references(() => tasks.id),
  actorPersonId: uuid("actor_person_id").references(() => people.id),
  action: text("action").notNull(),
  summary: text("summary").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  focoId: uuid("foco_id").unique(),
});

// 0011: avisos (o sino). Nascem de triggers ou do worker; a tela só marca como lido.
export const TIPOS_AVISO = ["tarefa_atribuida", "tarefa_concluida", "tarefa_comentario", "tarefa_lembrete", "tarefa_mencao", "tarefa_reacao", "ia_alerta", "ia_pergunta", "teste_push", "chamada_perdida", "risco", "erro_sistema"] as const;

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  personId: uuid("person_id").notNull().references(() => people.id),
  actorPersonId: uuid("actor_person_id").references(() => people.id),
  kind: text("kind", { enum: TIPOS_AVISO }).notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  taskId: uuid("task_id").references(() => tasks.id),
  missionId: uuid("mission_id").references(() => missions.id),
  dedupeKey: text("dedupe_key").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
  // 0040: incluído num e-mail (ou fora dele) pelo worker.
  emailStatus: text("email_status", { enum: ["enviado", "ensaio", "ignorado"] }),
  emailedAt: timestamp("emailed_at", { withTimezone: true }),
});

/** O que cada pessoa quer por e-mail (0040); sem linha, vale o padrão. */
export const emailPreferences = pgTable("email_preferences", {
  personId: uuid("person_id").primaryKey().references(() => people.id),
  lembretes: boolean("lembretes").notNull().default(true),
  atribuicoes: boolean("atribuicoes").notNull().default(true),
  mencoes: boolean("mencoes").notNull().default(true),
  comentarios: boolean("comentarios").notNull().default(true),
  concluidas: boolean("concluidas").notNull().default(false),
  resumoSemanal: boolean("resumo_semanal").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** E-mails de aviso e resumo semanal montados pelo worker (0040; a tela não lê). */
export const notificationEmails = pgTable("notification_emails", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  personId: uuid("person_id").notNull().references(() => people.id),
  kind: text("kind", { enum: ["avisos", "semanal_atrasadas", "semanal_semana"] }).notNull(),
  toAddress: text("to_address").notNull(),
  subject: text("subject").notNull(),
  notificationIds: uuid("notification_ids").array().notNull().default(sql`'{}'`),
  taskCount: integer("task_count").notNull().default(0),
  mode: text("mode", { enum: ["ensaio", "real"] }).notNull(),
  status: text("status", { enum: ["ensaio", "enviado", "falhou"] }).notNull(),
  error: text("error"),
  dedupeKey: text("dedupe_key").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 0012: chaves da API /api/v1 (só o hash SHA-256, igual ao Foco) e códigos PKCE do Prisma.
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  personId: uuid("person_id").notNull().references(() => people.id),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: bytea("key_hash").notNull().unique(),
  scopes: text("scopes").array().notNull(),
  client: text("client", { enum: ["prisma"] }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  focoId: uuid("foco_id").unique(),
});

// 0015: menções com @pessoa nos comentários (como comment_mentions do Foco).
export const taskCommentMentions = pgTable(
  "task_comment_mentions",
  {
    commentId: uuid("comment_id").notNull().references(() => taskComments.id),
    personId: uuid("person_id").notNull().references(() => people.id),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.personId] })],
);

// ---------------------------------------------------------------- 0016: Entrega B do filtroAPP (cópias de leitura)

const dinheiro = (nome: string) => numeric(nome, { precision: 14, scale: 2, mode: "number" });

export const missionMeasurements = pgTable("mission_measurements", {
  missionId: uuid("mission_id").primaryKey().references(() => missions.id),
  situacao: text("situacao", { enum: ["SEM_MEDICAO", "PREPARADA", "ENVIADA", "APROVADA"] }).notNull(),
  preparedAt: timestamp("prepared_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  saldoPendente: boolean("saldo_pendente"),
  executedAmount: dinheiro("executed_amount"),
  measuredAmount: dinheiro("measured_amount"),
  approvedAmount: dinheiro("approved_amount"),
  currency: text("currency"),
  filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const missionInvoices = pgTable("mission_invoices", {
  id: text("id").primaryKey(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  tipo: text("tipo", { enum: ["NFSE", "NFE", "ND"] }).notNull(),
  numero: text("numero").notNull(),
  serie: text("serie"),
  dataEmissao: timestamp("data_emissao", { withTimezone: true }).notNull(),
  valor: dinheiro("valor"),
  situacaoRecebimento: text("situacao_recebimento", { enum: ["RECEBIDA", "PARCIAL", "EM_ABERTO", "ATRASADA", "DESCONHECIDA"] }).notNull(),
  filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const missionRomaneios = pgTable("mission_romaneios", {
  id: text("id").primaryKey(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  tipo: text("tipo", { enum: ["SAIDA", "RETORNO"] }).notNull(),
  data: timestamp("data", { withTimezone: true }).notNull(),
  emitidoEm: timestamp("emitido_em", { withTimezone: true }),
  quantidadeItens: integer("quantidade_itens").notNull(),
  pesoCarga: numeric("peso_carga", { precision: 12, scale: 3, mode: "number" }),
  unidadePeso: text("unidade_peso"),
  filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const missionPending = pgTable("mission_pending", {
  missionId: uuid("mission_id").primaryKey().references(() => missions.id),
  aPagarQtd: integer("a_pagar_qtd").notNull(),
  aPagarValor: dinheiro("a_pagar_valor"),
  aPagarVencimento: timestamp("a_pagar_vencimento", { withTimezone: true }),
  aReceberQtd: integer("a_receber_qtd").notNull(),
  aReceberValor: dinheiro("a_receber_valor"),
  aReceberVencimento: timestamp("a_receber_vencimento", { withTimezone: true }),
  filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const missionUnloadings = pgTable("mission_unloadings", {
  id: text("id").primaryKey(),
  romaneioId: text("romaneio_id").notNull(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  tipo: text("tipo", { enum: ["PARCIAL", "TOTAL"] }).notNull(),
  confirmadaEm: timestamp("confirmada_em", { withTimezone: true }).notNull(),
  confirmadaPorEmail: text("confirmada_por_email").notNull(),
  cte: jsonb("cte").$type<{ numero: string; emissao: string | null; transportadora: string | null } | null>(),
  filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiUnloadings = pgTable("ai_unloadings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  questionId: uuid("question_id").notNull().unique().references(() => aiQuestions.id),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  idempotencyKey: uuid("idempotency_key").notNull().unique().default(sql`gen_random_uuid()`),
  request: jsonb("request").$type<{ romaneioId: string; tipo: "PARCIAL" | "TOTAL"; confirmadaEm: string }>().notNull(),
  status: text("status", { enum: ["pendente", "enviado", "simulado", "ensaio", "falhou"] }).notNull().default("pendente"),
  filtroappId: text("filtroapp_id"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  createdBy: uuid("created_by").notNull().references(() => people.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

// ---------------------------------------------------------------- 0017: revisão semanal

export const missionQualityRecords = pgTable("mission_quality_records", {
  id: text("id").primaryKey(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  number: text("number").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  impact: text("impact"),
  eventDate: date("event_date"),
  nature: text("nature"),
  actionDeadline: date("action_deadline"),
  recurrent: boolean("recurrent"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const missionProgressHistory = pgTable(
  "mission_progress_history",
  {
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    dia: date("dia").notNull(),
    progressPercent: numeric("progress_percent", { precision: 6, scale: 2, mode: "number" }),
    stage: text("stage"),
  },
  (t) => [primaryKey({ columns: [t.missionId, t.dia] })],
);

// ---------------------------------------------------------------- 0018: Gestão do filtroAPP (B6)

const percentual = (nome: string) => numeric(nome, { precision: 6, scale: 2, mode: "number" });
const minutos = (nome: string) => numeric(nome, { precision: 12, scale: 2, mode: "number" });

export const missionWeeklyProgress = pgTable(
  "mission_weekly_progress",
  {
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    weekStart: date("week_start").notNull(),
    avancoInicio: percentual("avanco_inicio"),
    avancoFim: percentual("avanco_fim"),
    metaPontos: percentual("meta_pontos"),
    metaDefinidaPor: text("meta_definida_por", { enum: ["PROJETO", "GRUPO"] }),
    revisaoConcluidaEm: timestamp("revisao_concluida_em", { withTimezone: true }),
    revisaoPendencias: integer("revisao_pendencias"),
    revisaoItens: jsonb("revisao_itens").$type<{ codigo: string; rotulo: string; ok: boolean }[] | null>(),
    /** 0019: meta como cadastrada no filtroAPP (formato de `MetaFiltroApp`, @omni/core). */
    meta: jsonb("meta").$type<MetaFiltroApp | null>(),
    filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.missionId, t.weekStart] })],
);

/** Só o worker lê e escreve; a tela usa app.custos_missoes() (gerente e diretoria). */
export const missionCosts = pgTable("mission_costs", {
  missionId: uuid("mission_id").primaryKey().references(() => missions.id),
  precoVenda: dinheiro("preco_venda"),
  custoPrevisto: dinheiro("custo_previsto"),
  margemPrevista: numeric("margem_prevista", { precision: 8, scale: 2, mode: "number" }),
  diasPrevistos: numeric("dias_previstos", { precision: 8, scale: 2, mode: "number" }),
  custoTotal: dinheiro("custo_total").notNull(),
  custoPorCategoria: jsonb("custo_por_categoria").$type<{ codigo: string; rotulo: string; valor: number }[]>().notNull(),
  custoAte: date("custo_ate").notNull(),
  avancoFisico: percentual("avanco_fisico"),
  consumoDoCusto: integer("consumo_do_custo"),
  filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const missionConditions = pgTable("mission_conditions", {
  missionId: uuid("mission_id").primaryKey().references(() => missions.id),
  permanenciaPrevistaDias: numeric("permanencia_prevista_dias", { precision: 8, scale: 2, mode: "number" }),
  diariaStandBy: dinheiro("diaria_stand_by"),
  filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const missionAllocations = pgTable("mission_allocations", {
  id: text("id").primaryKey(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  collaboratorId: text("collaborator_id").notNull(),
  funcao: text("funcao"),
  mobilizacao: date("mobilizacao"),
  desmobilizacao: date("desmobilizacao"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const missionTimesheetWeeks = pgTable(
  "mission_timesheet_weeks",
  {
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    weekStart: date("week_start").notNull(),
    minutosNormais: minutos("minutos_normais").notNull(),
    minutosExtra70: minutos("minutos_extra_70").notNull(),
    minutosExtra100: minutos("minutos_extra_100").notNull(),
    minutosNoturnos: minutos("minutos_noturnos").notNull(),
    pessoas: integer("pessoas").notNull(),
    filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.missionId, t.weekStart] })],
);

// ---------------------------------------------------------------- 0020: pastas comerciais (Prisma 1.66.0)
// Só o worker lê e escreve; a tela usa app.pastas_da_missao / pastas_do_cliente / pasta_para_leitura.

export const prismaCompanies = pgTable("prisma_companies", {
  id: text("id").primaryKey(),
  name: text("name"),
  taxId: text("tax_id"),
  /** 0022: domínios de e-mail da empresa (vínculo de e-mails por domínio). */
  emailDomains: text("email_domains").array().notNull().default(sql`'{}'`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  prismaUpdatedAt: timestamp("prisma_updated_at", { withTimezone: true }),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const prismaDeals = pgTable("prisma_deals", {
  id: text("id").primaryKey(),
  code: text("code"),
  proposalCode: text("proposal_code"),
  title: text("title"),
  status: text("status"),
  companyId: text("company_id"),
  prismaMissionId: text("prisma_mission_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  prismaUpdatedAt: timestamp("prisma_updated_at", { withTimezone: true }),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const prismaMissions = pgTable("prisma_missions", {
  id: text("id").primaryKey(),
  number: text("number"),
  title: text("title"),
  status: text("status"),
  companyIds: text("company_ids").array().notNull().default(sql`'{}'`),
  dealIds: text("deal_ids").array().notNull().default(sql`'{}'`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  prismaUpdatedAt: timestamp("prisma_updated_at", { withTimezone: true }),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const prismaMissionLinks = pgTable("prisma_mission_links", {
  prismaMissionId: text("prisma_mission_id").primaryKey().references(() => prismaMissions.id),
  missionId: uuid("mission_id").notNull().unique().references(() => missions.id),
  method: text("method", { enum: ["numero", "filtroapp"] }).notNull(),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sharepointFolderRefs = pgTable("sharepoint_folder_refs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerType: text("owner_type", { enum: ["deal", "mission"] }).notNull(),
  ownerId: text("owner_id").notNull(),
  driveId: text("drive_id"),
  folderId: text("folder_id").notNull(),
  webUrl: text("web_url"),
  source: text("source", { enum: ["opportunity", "mission"] }).notNull(),
  status: text("status", { enum: ["ready", "configuration_required"] }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------- 0022: e-mails da missão (Outlook)
// A tela só lê pelas funções app.emails_da_missao / abrir_email / leituras_email.

export type DestinatarioEmail = { nome: string | null; endereco: string };

export const mailMailboxes = pgTable("mail_mailboxes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  active: boolean("active").notNull().default(true),
  addedBy: uuid("added_by").references(() => people.id),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
});

export const mailMessages = pgTable("mail_messages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  internetMessageId: text("internet_message_id").notNull().unique(),
  conversationId: text("conversation_id"),
  subject: text("subject"),
  fromName: text("from_name"),
  fromAddress: text("from_address"),
  toRecipients: jsonb("to_recipients").$type<DestinatarioEmail[]>().notNull().default([]),
  ccRecipients: jsonb("cc_recipients").$type<DestinatarioEmail[]>().notNull().default([]),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  bodyPreview: text("body_preview"),
  hasAttachments: boolean("has_attachments").notNull().default(false),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mailMessageCopies = pgTable(
  "mail_message_copies",
  {
    mailboxId: uuid("mailbox_id").notNull().references(() => mailMailboxes.id),
    graphId: text("graph_id").notNull(),
    messageId: uuid("message_id").notNull().references(() => mailMessages.id),
    folder: text("folder", { enum: ["inbox", "sentitems"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.mailboxId, t.graphId] })],
);

export const mailMessageMissions = pgTable(
  "mail_message_missions",
  {
    messageId: uuid("message_id").notNull().references(() => mailMessages.id),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    motivo: text("motivo", { enum: ["numero", "proposta", "nf", "dominio"] }).notNull(),
    detalhe: text("detalhe").notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.missionId, t.motivo] })],
);

/** 0023: pares e-mail × missão desvinculados por alguém (o worker não religa). */
export const mailLinkExclusions = pgTable(
  "mail_link_exclusions",
  {
    internetMessageId: text("internet_message_id").notNull(),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    excludedBy: uuid("excluded_by").notNull().references(() => people.id),
    excludedAt: timestamp("excluded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.internetMessageId, t.missionId] })],
);

// ---------------------------------------------------------------- 0024: envio de e-mail

export const emailSignatures = pgTable("email_signatures", {
  personId: uuid("person_id").primaryKey().references(() => people.id),
  signature: text("signature").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mailOutbox = pgTable("mail_outbox", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  personId: uuid("person_id").notNull().references(() => people.id),
  missionId: uuid("mission_id").references(() => missions.id),
  fromAddress: text("from_address").notNull(),
  toRecipients: jsonb("to_recipients").$type<string[]>().notNull(),
  ccRecipients: jsonb("cc_recipients").$type<string[]>().notNull().default([]),
  bccRecipients: jsonb("bcc_recipients").$type<string[]>().notNull().default([]),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  replyToMessage: uuid("reply_to_message").references(() => mailMessages.id),
  /** 0064: anexos enviados (só nome, tipo e tamanho; o conteúdo não fica no Omni). */
  attachments: jsonb("attachments").$type<{ nome: string; tipo: string; tamanho: number }[]>().notNull().default([]),
  mode: text("mode", { enum: ["ensaio", "real"] }).notNull(),
  status: text("status", { enum: ["pendente", "ensaio", "enviado", "falhou"] }).notNull().default("pendente"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

// ---------------------------------------------------------------- 0025: IA v2 — leitura dos RDOs

/** Metadados de cada chamada ao LLM (nunca o texto). */
export const llmCalls = pgTable("llm_calls", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  purpose: text("purpose").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  durationMs: integer("duration_ms"),
  outcome: text("outcome", { enum: ["ok", "erro"] }).notNull(),
  errorCode: text("error_code"),
  missionId: uuid("mission_id").references(() => missions.id),
  dataIds: jsonb("data_ids").$type<Record<string, string>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rdoAnalyses = pgTable("rdo_analyses", {
  reportId: text("report_id").primaryKey().references(() => reports.id),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  promptVersion: text("prompt_version").notNull(),
  model: text("model"),
  points: jsonb("points").$type<{ tipo: string; resumo: string; trecho: string | null }[]>().notNull().default([]),
  questionId: uuid("question_id").references(() => aiQuestions.id),
  llmCallId: uuid("llm_call_id").references(() => llmCalls.id),
  analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------- 0026: reuniões do Teams

export type ResumoReuniaoBanco = { resumo: string; decisoes: string[]; pendencias: { descricao: string; responsavel: string | null; prazo: string | null }[] };

export const meetings = pgTable("meetings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  icalUid: text("ical_uid").notNull().unique(),
  subject: text("subject"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  organizerName: text("organizer_name"),
  organizerAddress: text("organizer_address"),
  attendees: jsonb("attendees").$type<{ nome: string | null; endereco: string }[]>().notNull().default([]),
  joinUrl: text("join_url"),
  bodyPreview: text("body_preview"),
  onlineMeetingId: text("online_meeting_id"),
  organizerUserId: text("organizer_user_id"),
  transcriptStatus: text("transcript_status", {
    enum: ["pendente", "sem_link", "sem_transcricao", "sem_acesso", "acesso_desligado", "disponivel", "resumida", "erro"],
  })
    .notNull()
    .default("pendente"),
  transcriptAttempts: integer("transcript_attempts").notNull().default(0),
  transcriptCheckedAt: timestamp("transcript_checked_at", { withTimezone: true }),
  summary: jsonb("summary").$type<ResumoReuniaoBanco | null>(),
  summaryModel: text("summary_model"),
  summarizedAt: timestamp("summarized_at", { withTimezone: true }),
  summaryPostedAt: timestamp("summary_posted_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export const meetingCopies = pgTable(
  "meeting_copies",
  {
    mailboxId: uuid("mailbox_id").notNull().references(() => mailMailboxes.id),
    eventId: text("event_id").notNull(),
    meetingId: uuid("meeting_id").notNull().references(() => meetings.id),
  },
  (t) => [primaryKey({ columns: [t.mailboxId, t.eventId] })],
);

export const meetingMissions = pgTable(
  "meeting_missions",
  {
    meetingId: uuid("meeting_id").notNull().references(() => meetings.id),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    motivo: text("motivo", { enum: ["numero", "proposta", "nf", "dominio"] }).notNull(),
    detalhe: text("detalhe").notNull(),
  },
  (t) => [primaryKey({ columns: [t.meetingId, t.missionId, t.motivo] })],
);

// ---------------------------------------------------------------- 0027: WhatsApp (Evolution)

export const whatsappNumbers = pgTable("whatsapp_numbers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  instanceName: text("instance_name").notNull().unique(),
  label: text("label").notNull(),
  purpose: text("purpose", { enum: ["operacao", "campo", "gestao", "outro"] }).notNull(),
  ownerPersonId: uuid("owner_person_id").references(() => people.id),
  phone: text("phone"),
  profileName: text("profile_name"),
  status: text("status", { enum: ["criado", "conectando", "conectado", "desconectado", "removido"] }).notNull().default("criado"),
  statusAt: timestamp("status_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  createdBy: uuid("created_by").references(() => people.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const whatsappNumberMembers = pgTable(
  "whatsapp_number_members",
  {
    numberId: uuid("number_id").notNull().references(() => whatsappNumbers.id),
    personId: uuid("person_id").notNull().references(() => people.id),
    addedBy: uuid("added_by").references(() => people.id),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.numberId, t.personId] })],
);

// Chamadas e gravações seguem a propriedade da pessoa, sem acesso implícito da gestão.
export const whatsappCallPermissions = pgTable("whatsapp_call_permissions", {
  personId: uuid("person_id").primaryKey().references(() => people.id),
  canRecord: boolean("can_record").notNull().default(false),
  updatedBy: uuid("updated_by").references(() => people.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type ResumoChamadaBanco = { resumo: string; decisoes: string[]; pendencias: { descricao: string; responsavel: string | null; prazo: string | null }[] };
export const whatsappCalls = pgTable("whatsapp_calls", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  numberId: uuid("number_id").notNull().references(() => whatsappNumbers.id),
  ownerPersonId: uuid("owner_person_id").notNull().references(() => people.id),
  recordingId: text("recording_id").notNull(), peer: text("peer").notNull(),
  direction: text("direction", { enum: ["entrada", "saida"] }).notNull(),
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }), endedAt: timestamp("ended_at", { withTimezone: true }),
  recording: boolean("recording").notNull().default(false), audio: boolean("audio").notNull().default(false),
  recordingError: boolean("recording_error").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // 0038: resumo pela IA (o worker só lê colunas liberadas a ele).
  summary: jsonb("summary").$type<ResumoChamadaBanco>(),
  summaryStatus: text("summary_status", { enum: ["pendente", "resumida", "sem_fala", "erro"] }),
  summaryModel: text("summary_model"),
  summarizedAt: timestamp("summarized_at", { withTimezone: true }),
  summaryAttempts: integer("summary_attempts").notNull().default(0),
  // 0062: transcrição (mesma visibilidade do resumo; excluir a gravação apaga).
  transcript: text("transcript"),
  // 0052: onde está o arquivo da gravação (serviço de voz ou SharePoint) e o arquivamento.
  arquivoLocal: text("arquivo_local", { enum: ["voz", "sharepoint"] }).notNull().default("voz"),
  spDriveId: text("sp_drive_id"),
  spItemId: text("sp_item_id"),
  arquivoBytes: bigint("arquivo_bytes", { mode: "number" }),
  arquivoFormato: text("arquivo_formato", { enum: ["wav", "m4a"] }),
  arquivadoEm: timestamp("arquivado_em", { withTimezone: true }),
  arquivamentoTentativas: integer("arquivamento_tentativas").notNull().default(0),
  spApagadoEm: timestamp("sp_apagado_em", { withTimezone: true }),
  // 0053: chave da gravação embrulhada pela chave mestra (apagada ao excluir).
  chaveCifrada: bytea("chave_cifrada"),
  chaveVersao: integer("chave_versao"),
});
export const whatsappCallShares = pgTable("whatsapp_call_shares", {
  callId: uuid("call_id").notNull().references(() => whatsappCalls.id), personId: uuid("person_id").notNull().references(() => people.id),
  sharedBy: uuid("shared_by").notNull().references(() => people.id), sharedAt: timestamp("shared_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.callId, t.personId] })]);

export const whatsappChats = pgTable("whatsapp_chats", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  numberId: uuid("number_id").notNull().references(() => whatsappNumbers.id),
  jid: text("jid").notNull(),
  isGroup: boolean("is_group").notNull(),
  phone: text("phone"),
  name: text("name"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  lastPreview: text("last_preview"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // 0048: id de privacidade (…@lid) da pessoa, endereço da foto no WhatsApp e última leitura do perfil.
  lid: text("lid"),
  photoUrl: text("photo_url"),
  profileSyncAt: timestamp("profile_sync_at", { withTimezone: true }),
  /** 0069: nome dado pelo dono do número no Omni (a agenda do celular não sobrescreve). */
  nameManual: boolean("name_manual").notNull().default(false),
});

export const whatsappMessages = pgTable("whatsapp_messages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  chatId: uuid("chat_id").notNull().references(() => whatsappChats.id),
  waId: text("wa_id").notNull(),
  fromMe: boolean("from_me").notNull(),
  authorJid: text("author_jid"),
  authorName: text("author_name"),
  kind: text("kind", { enum: ["texto", "imagem", "video", "audio", "documento", "figurinha", "localizacao", "contato", "outro"] }).notNull(),
  body: text("body"),
  fileName: text("file_name"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  status: text("status", { enum: ["enviada", "entregue", "lida", "erro"] }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Conversas concluídas por pessoa (0035): voltam quando chega mensagem nova do contato. */
export const whatsappChatConcluded = pgTable(
  "whatsapp_chat_concluded",
  {
    personId: uuid("person_id").notNull().references(() => people.id),
    chatId: uuid("chat_id").notNull().references(() => whatsappChats.id),
    concludedAt: timestamp("concluded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.chatId] })],
);

/** Plano de fundo das conversas de cada pessoa: geral (chatId nulo) ou por conversa (0061). "<cor>|<padrão>". */
export const whatsappFundos = pgTable("whatsapp_fundos", {
  id: uuid("id").primaryKey().defaultRandom(),
  personId: uuid("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  chatId: uuid("chat_id").references(() => whatsappChats.id, { onDelete: "cascade" }),
  fundo: text("fundo").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------- 0028: WhatsApp na missão, histórico e envio

export const whatsappChatMissions = pgTable(
  "whatsapp_chat_missions",
  {
    chatId: uuid("chat_id").notNull().references(() => whatsappChats.id),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    linkedBy: uuid("linked_by").references(() => people.id),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.missionId] })],
);

export const whatsappHistoryImports = pgTable("whatsapp_history_imports", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  numberId: uuid("number_id").notNull().references(() => whatsappNumbers.id),
  groupJids: text("group_jids").array().notNull(),
  requestedBy: uuid("requested_by").references(() => people.id),
  status: text("status", { enum: ["pendente", "importando", "concluida", "erro"] }).notNull().default("pendente"),
  imported: integer("imported").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const whatsappOutbox = pgTable("whatsapp_outbox", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  chatId: uuid("chat_id").notNull().references(() => whatsappChats.id),
  personId: uuid("person_id").notNull().references(() => people.id),
  origem: text("origem", { enum: ["conversa"] }).notNull().default("conversa"),
  body: text("body").notNull(),
  mode: text("mode", { enum: ["ensaio", "real"] }).notNull(),
  status: text("status", { enum: ["registrada", "enviada", "erro"] }).notNull().default("registrada"),
  waId: text("wa_id"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  fileName: text("file_name"),
  fileMime: text("file_mime"),
  fileSize: integer("file_size"),
});

// ---------------------------------------------------------------- 0030: sugestão recusada e arquivo enviado

export const whatsappLinkDismissals = pgTable(
  "whatsapp_link_dismissals",
  {
    chatId: uuid("chat_id").notNull().references(() => whatsappChats.id),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    dismissedBy: uuid("dismissed_by").notNull().references(() => people.id),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.missionId] })],
);

// ---------------------------------------------------------------- 0031: alertas da IA e Web Push

export type RegraAlerta = {
  fonte: "rdo";
  tipo: "ausencia" | "presenca";
  oQue: string;
  dias: number;
  marcar: "LEADER" | "PLANNER" | "FIELD_OPERATOR" | "eu";
};

export const aiAlerts = pgTable("ai_alerts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  channel: text("channel", { enum: CANAIS }).notNull(),
  createdBy: uuid("created_by").notNull().references(() => people.id),
  requestText: text("request_text").notNull(),
  spec: jsonb("spec").$type<RegraAlerta>().notNull(),
  examples: text("examples").array().notNull().default(sql`'{}'`),
  status: text("status", { enum: ["rascunho", "ativo", "pausado", "cancelado"] }).notNull().default("rascunho"),
  afterDate: date("after_date"),
  promptVersion: text("prompt_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  fires: integer("fires").notNull().default(0),
});

export const aiAlertChecks = pgTable(
  "ai_alert_checks",
  {
    alertId: uuid("alert_id").notNull().references(() => aiAlerts.id),
    reportId: text("report_id").notNull().references(() => reports.id),
    present: boolean("present").notNull(),
    quote: text("quote"),
    model: text("model"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.alertId, t.reportId] })],
);

export const aiAlertFires = pgTable("ai_alert_fires", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  alertId: uuid("alert_id").notNull().references(() => aiAlerts.id),
  reportIds: text("report_ids").array().notNull(),
  status: text("status", { enum: ["pendente", "publicado"] }).notNull().default("pendente"),
  messageId: uuid("message_id").references(() => missionMessages.id),
  answer: jsonb("answer").$type<{ opcao: "nao_veio" | "cobrar" | "veio"; exemplo: string | null } | null>(),
  answeredBy: uuid("answered_by").references(() => people.id),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  personId: uuid("person_id").notNull().references(() => people.id),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  failures: integer("failures").notNull().default(0),
});

export const pushPreferences = pgTable("push_preferences", {
  personId: uuid("person_id").primaryKey().references(() => people.id),
  canais: boolean("canais").notNull().default(true),
  whatsapp: boolean("whatsapp").notNull().default(true),
  /** 0067: e-mail novo na própria caixa. */
  email: boolean("email").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Participantes da missão completados à mão (0042); a lista vem dos e-mails e do WhatsApp. */
export const missionParticipantNotes = pgTable(
  "mission_participant_notes",
  {
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    chave: text("chave").notNull(),
    nome: text("nome"),
    cargo: text("cargo"),
    empresa: text("empresa"),
    lado: text("lado", { enum: ["cliente", "filtrovali", "terceiro"] }),
    oculto: boolean("oculto").notNull().default(false),
    // 0047: enviado ao Prisma como participante do cliente.
    prismaContactId: text("prisma_contact_id"),
    prismaVinculadoEm: timestamp("prisma_vinculado_em", { withTimezone: true }),
    updatedBy: uuid("updated_by").notNull().references(() => people.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.missionId, t.chave] })],
);

/** Assinatura extraída por remetente externo (0044); só o worker grava, a tela lê por app.assinaturas_da_missao. */
export const emailSignatureExtractions = pgTable("email_signature_extractions", {
  address: text("address").primaryKey(),
  nome: text("nome"),
  cargo: text("cargo"),
  empresa: text("empresa"),
  telefone: text("telefone"),
  messageId: uuid("message_id").references(() => mailMessages.id),
  status: text("status", { enum: ["ok", "sem_assinatura", "erro"] }).notNull(),
  attempts: integer("attempts").notNull().default(1),
  model: text("model"),
  extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Liberados à mão pela Diretoria ou Administração para ver a missão (0045). */
export const missionViewers = pgTable(
  "mission_viewers",
  {
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    personId: uuid("person_id").notNull().references(() => people.id),
    addedBy: uuid("added_by").notNull().references(() => people.id),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.missionId, t.personId] })],
);

/** Feedback registrado no Prisma por pessoa (0047): a chave é a de idempotência (não duplica). */
export const prismaFeedbackLog = pgTable(
  "prisma_feedback_log",
  {
    chave: uuid("chave").primaryKey(),
    personId: uuid("person_id").notNull().references(() => people.id),
    origem: text("origem", { enum: ["chamada", "email"] }).notNull(),
    origemId: text("origem_id").notNull(),
    prismaId: text("prisma_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.personId, t.origem, t.origemId)],
);

/** Aceites do termo de uso e privacidade (0051): versão, SHA-256 do texto, quando e de onde. */
export const termsAcceptances = pgTable(
  "terms_acceptances",
  {
    personId: uuid("person_id").notNull().references(() => people.id),
    versao: text("versao").notNull(),
    textoSha256: text("texto_sha256").notNull(),
    aceitoEm: timestamp("aceito_em", { withTimezone: true }).notNull().defaultNow(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [primaryKey({ columns: [t.personId, t.versao] })],
);

/** Pastas pessoais das listas de Missões e Conversas (0059). */
export const pastasPessoais = pgTable("pastas_pessoais", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  personId: uuid("person_id").notNull().references(() => people.id),
  tipo: text("tipo", { enum: ["missao", "conversa"] }).notNull(),
  nome: text("nome").notNull(),
  ordem: integer("ordem").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Item numa pasta pessoal e/ou arquivado, por pessoa (0059). */
export const organizacaoPessoal = pgTable(
  "organizacao_pessoal",
  {
    personId: uuid("person_id").notNull().references(() => people.id),
    tipo: text("tipo", { enum: ["missao", "conversa"] }).notNull(),
    itemId: uuid("item_id").notNull(),
    pastaId: uuid("pasta_id"),
    arquivadoEm: timestamp("arquivado_em", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.tipo, t.itemId] })],
);

// ---------------------------------------------------------------- 0065: alertas de risco

/** Volume fora do comum de downloads ou de arquivos enviados para fora, por pessoa (só admin e diretoria leem). */
export const riskAlerts = pgTable("risk_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["downloads_em_massa", "envio_para_fora"] }).notNull(),
  personId: uuid("person_id").notNull().references(() => people.id),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  reason: text("reason").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedBy: uuid("reviewed_by").references(() => people.id),
});

// ---------------------------------------------------------------- 0067: caixa única (agenda e cabeçalhos dos e-mails)

/** Agenda da empresa: um contato com vários e-mails e telefones. */
export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  company: text("company"),
  role: text("role"),
  prismaContactId: text("prisma_contact_id"),
  createdBy: uuid("created_by").references(() => people.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** E-mail (minúsculo) ou telefone (só dígitos, com DDI) de um contato; cada um pertence a um contato só. */
export const contactIdentities = pgTable("contact_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["email", "telefone"] }).notNull(),
  value: text("value").notNull(),
  /** 0068: de onde veio (manual, assinatura do e-mail, Prisma, sugestão aceita). */
  source: text("source", { enum: ["manual", "assinatura", "prisma", "sugestao"] }).notNull().default("manual"),
  createdBy: uuid("created_by").references(() => people.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Cabeçalho dos e-mails da caixa pessoal (Entrada e Enviados); só o dono lê. */
export const mailItems = pgTable("mail_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailMailboxes.id, { onDelete: "cascade" }),
  ownerPersonId: uuid("owner_person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  graphId: text("graph_id").notNull(),
  internetMessageId: text("internet_message_id"),
  conversationId: text("conversation_id"),
  folder: text("folder", { enum: ["inbox", "sentitems"] }).notNull(),
  fromName: text("from_name"),
  fromAddress: text("from_address"),
  toRecipients: jsonb("to_recipients").$type<{ nome: string | null; endereco: string }[]>().notNull().default([]),
  ccRecipients: jsonb("cc_recipients").$type<{ nome: string | null; endereco: string }[]>().notNull().default([]),
  addresses: text("addresses").array().notNull().default(sql`'{}'::text[]`),
  subject: text("subject"),
  preview: text("preview"),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  isRead: boolean("is_read").notNull().default(true),
  hasAttachments: boolean("has_attachments").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** "Não é a mesma pessoa" (0068): a sugestão de vínculo por nome some para quem recusou. */
export const contactLinkDismissals = pgTable(
  "contact_link_dismissals",
  {
    personId: uuid("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.email, t.phone] })],
);

/** Assinaturas de aviso do Graph (0070): e-mail novo na Entrada de cada caixa; o segredo só como SHA-256. */
export const graphSubscriptions = pgTable("graph_subscriptions", {
  id: text("id").primaryKey(),
  mailboxId: uuid("mailbox_id").notNull().unique().references(() => mailMailboxes.id, { onDelete: "cascade" }),
  secretSha256: bytea("secret_sha256").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
});

/** Liberação por módulo (0071): sem linha = todos; quem administra sempre vê. */
export const MODULOS = ["whatsapp", "emails", "missoes", "tarefas", "chamadas", "revisao"] as const;
export const moduleAccess = pgTable("module_access", {
  module: text("module", { enum: MODULOS }).primaryKey(),
  mode: text("mode", { enum: ["todos", "restrito", "ninguem"] }).notNull().default("todos"),
  profiles: perfil("profiles").array().notNull().default(sql`'{}'::perfil[]`),
  people: uuid("people").array().notNull().default(sql`'{}'::uuid[]`),
  updatedBy: uuid("updated_by").references(() => people.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Resumo por correspondente da caixa pessoal (0073), mantido por gatilho em mail_items; só o dono lê. */
export const mailCorrespondents = pgTable(
  "mail_correspondents",
  {
    ownerPersonId: uuid("owner_person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    name: text("name"),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
    lastItemId: uuid("last_item_id").notNull(),
    lastSubject: text("last_subject"),
    lastPreview: text("last_preview"),
    unread: integer("unread").notNull().default(0),
    total: integer("total").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.ownerPersonId, t.address] })],
);

/** Composição do avanço por serviço (0074), como veio do filtroAPP; substituída a cada leitura. */
export type ServicoDoAvanco = {
  escopo: string | null;
  servico: string;
  rotuloServico: string;
  equipamento: string | null;
  avancoPct: number | null;
  unidade: string | null;
  rotuloUnidade: string | null;
  previsto: number | null;
  realizado: number | null;
  sistemas: number;
};
export const missionServiceProgress = pgTable("mission_service_progress", {
  missionId: uuid("mission_id").primaryKey().references(() => missions.id, { onDelete: "cascade" }),
  avancoTotal: numeric("avanco_total", { precision: 7, scale: 2, mode: "number" }),
  servicos: jsonb("servicos").$type<ServicoDoAvanco[]>().notNull().default([]),
  filtroappUpdatedAt: timestamp("filtroapp_updated_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Lida / não lida nas conversas do WhatsApp, por pessoa (0075). */
export const whatsappChatReads = pgTable(
  "whatsapp_chat_reads",
  {
    personId: uuid("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id").notNull().references(() => whatsappChats.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
    markedUnread: boolean("marked_unread").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.personId, t.chatId] })],
);

/** Telefones citados no corpo dos e-mails (0076): só sugestão, achados sem IA. */
export const contactPhoneHints = pgTable(
  "contact_phone_hints",
  {
    address: text("address").notNull(),
    phone: text("phone").notNull(),
    origem: text("origem", { enum: ["corpo"] }).notNull().default("corpo"),
    foundAt: timestamp("found_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.address, t.phone] })],
);

/** Anexos das tarefas (0077): arquivo no SharePoint do Omni; os do Foco com `foco_id` e SHA-256. */
export const taskAttachments = pgTable("task_attachments", {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    spDriveId: text("sp_drive_id").notNull(),
    spItemId: text("sp_item_id").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => people.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    focoId: uuid("foco_id").unique(),
});


// ---------------------------------------------------------------- 0079: erros do sistema (E09, pilar 12.1)

/** Erros inesperados do web e do worker e problemas da operação, agrupados por assinatura. Só admin lê. */
export const systemErrors = pgTable("system_errors", {
  id: uuid("id").primaryKey().defaultRandom(),
  fingerprint: text("fingerprint").notNull().unique(),
  source: text("source", { enum: ["web", "worker", "operacao"] }).notNull(),
  name: text("name").notNull(),
  message: text("message").notNull(),
  detail: text("detail"),
  location: text("location").notNull(),
  version: text("version"),
  occurrences: integer("occurrences").notNull().default(1),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  alertedAt: timestamp("alerted_at", { withTimezone: true }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedBy: uuid("reviewed_by").references(() => people.id),
});
