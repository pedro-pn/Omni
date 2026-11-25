import { z } from "zod";

/** Hosts de produção dos outros apps (para travar escrita fora da produção). */
export const FILTROAPP_PRODUCAO = "app.filtrovali.com.br";

const schema = z
  .object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Staging roda com NODE_ENV=production, mas com as travas de fora da produção. */
  OMNI_AMBIENTE: z.enum(["desenvolvimento", "staging", "producao"]).optional(),
  DATABASE_URL_WORKER: z.url({ protocol: /^postgres(ql)?$/ }),
  TZ_EMPRESA: z.string().default("America/Sao_Paulo"),
  // Opcionais até a sincronização com o filtroAPP (Fase 2) existir.
  FILTROAPP_API_URL: z.url({ protocol: /^https$/ }).default("https://app.filtrovali.com.br/api/integracoes/v1"),
  FILTROAPP_API_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(20).optional()),
  // Toda escrita no filtroAPP: "desligada" (só registra no Omni), "simulada"
  // (filtroAPP valida com dados reais e não grava) ou "real".
  FILTROAPP_ESCRITA: z.enum(["desligada", "simulada", "real"]).default("desligada"),
  PRISMA_OMNI_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  // Credencial `reader` da aplicação no Prisma (só no servidor): oportunidades, missões e pastas do SharePoint.
  // Microsoft Graph, app "Omni – Integrações" (Fase 4): e-mails das caixas autorizadas.
  // O compose passa "" para variável não definida: vale como ausente.
  GRAPH_TENANT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // Chave mestra das gravações no SharePoint (openssl rand -hex 32; a mesma no web). Perdê-la = perder as gravações.
  GRAVACOES_CHAVE_MESTRA: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[0-9a-f]{64}$/).optional()),
  // Biblioteca do site OmniAnexos (SharePoint): gravações das ligações (job chamadas-arquivar).
  GRAPH_ANEXOS_DRIVE_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[A-Za-z0-9!_.,-]{10,300}$/).optional()),
  // Id do app "Omni" do login (Entra): o worker lê quem está atribuído a ele (job entra-pessoas).
  ENTRA_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.uuid().optional()),
  GRAPH_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  GRAPH_PRIVATE_KEY_PATH: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  GRAPH_CERT_SHA256_THUMBPRINT: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[a-fA-F0-9]{64}$/).optional()),
  /** Evolution própria do Omni (ADR 0004): o worker só confere o estado dos números. */
  WHATSAPP_EVOLUTION_URL: z.preprocess((v) => (v === "" ? undefined : v), z.url({ protocol: /^https?$/ }).optional()),
  WHATSAPP_EVOLUTION_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(32).optional()),
  // IA v2 (ADR 0005): leitura dos RDOs pelo LLM. Desligada por padrão (manda o texto do RDO à OpenAI).
  IA_LEITURA_RDO: z.enum(["desligada", "ligada"]).default("desligada"),
  /** Resumo das reuniões do Teams da missão pelo LLM (precisa do acesso às transcrições ligado no tenant). */
  IA_RESUMO_REUNIAO: z.enum(["desligada", "ligada"]).default("desligada"),
  OPENAI_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(20).optional()),
  OPENAI_MODEL: z.string().min(3).default("gpt-6-luna"),
  /** Resumo das ligações gravadas: transcrição e resumo na OpenAI (autorizado em 10/11/2026; consta do registro de LGPD). */
  IA_RESUMO_CHAMADA: z.enum(["desligada", "ligada"]).default("desligada"),
  OPENAI_TRANSCRICAO_MODEL: z.string().min(3).default("gpt-4o-transcribe"),
  /** Serviço de voz das chamadas (mesmos valores do web): o worker busca o áudio para o resumo. */
  CHAMADAS_SERVICO_URL: z.preprocess((v) => (v === "" ? undefined : v), z.url({ protocol: /^http$/ }).optional()),
  CHAMADAS_SERVICO_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(32).optional()),
  /** Avisos das tarefas por e-mail e resumo semanal: mesmo modo do envio do web ("real" só na produção). */
  EMAIL_ENVIO: z.enum(["desligado", "ensaio", "real"]).default("ensaio"),
  /** Caixa que envia os avisos (precisa estar no grupo "Omni - Caixas" do Exchange). */
  EMAIL_AVISOS_REMETENTE: z.preprocess((v) => (v === "" ? undefined : v), z.email().optional()),
  /** Endereço do Omni nos links dos e-mails. */
  APP_ORIGIN: z.url().default("https://omni.filtrovali.com.br"),
  /** Nome, cargo e empresa dos participantes pela assinatura dos e-mails (autorizado em 10/11/2026; LGPD). */
  IA_ASSINATURAS: z.enum(["desligada", "ligada"]).default("desligada"),
  /** Alertas pedidos à IA no Interno/Gerencial (@IA, /alerta): leitura dos RDOs contra cada alerta ativo. */
  IA_ALERTAS: z.enum(["desligada", "ligada"]).default("desligada"),
  /** Status do backup e do ensaio (deploy/backup-prod.sh, restore-drill.sh) montado em OPERACAO_STATUS_DIR (só produção). */
  OPERACAO_STATUS: z.enum(["desligado", "ligado"]).default("desligado"),
  OPERACAO_STATUS_DIR: z.string().default("/ops-status"),
  /**
   * Aviso imediato de e-mail novo (0070): o Graph avisa em APP_ORIGIN/api/graph/avisos
   * (precisa ser HTTPS público) e o worker lê as caixas na hora.
   */
  EMAIL_AVISO_IMEDIATO: z.enum(["desligado", "ligado"]).default("desligado"),
  // Retenção por tipo de dado (0066): "ensaio" só conta o que apagaria; "real" apaga.
  RETENCAO: z.enum(["desligada", "ensaio", "real"]).default("ensaio"),
  /** Notificações no celular (Web Push). Chaves VAPID: `npx web-push generate-vapid-keys`. */
  WEB_PUSH_PUBLIC_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[A-Za-z0-9_-]{80,100}$/).optional()),
  WEB_PUSH_PRIVATE_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^[A-Za-z0-9_-]{40,50}$/).optional()),
  WEB_PUSH_SUBJECT: z.string().regex(/^(https:\/\/|mailto:)/).default("https://omni.filtrovali.com.br"),
  PRISMA_OMNI_READER_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^prisma_omni_reader_[a-f0-9]{64}$/).optional()),
})
  .superRefine((env, ctx) => {
    // Fora da produção do Omni, nada grava na produção dos outros apps.
    if (env.OMNI_AMBIENTE === "producao" && env.NODE_ENV !== "production") {
      ctx.addIssue({ code: "custom", path: ["OMNI_AMBIENTE"], message: "produção exige NODE_ENV=production" });
    }
    if (env.EMAIL_AVISO_IMEDIATO === "ligado" && !env.APP_ORIGIN.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "o aviso imediato do Graph precisa de endereço HTTPS público" });
    }
    if ((env.OMNI_AMBIENTE ?? (env.NODE_ENV === "production" ? "producao" : "desenvolvimento")) === "producao") return;
    if (env.EMAIL_AVISO_IMEDIATO === "ligado" && new URL(env.APP_ORIGIN).host === "omni.filtrovali.com.br") {
      ctx.addIssue({ code: "custom", path: ["EMAIL_AVISO_IMEDIATO"], message: "fora da produção, o aviso do Graph não pode apontar para o endereço da produção" });
    }
    if (env.FILTROAPP_ESCRITA === "real" && new URL(env.FILTROAPP_API_URL).host === FILTROAPP_PRODUCAO) {
      ctx.addIssue({
        code: "custom",
        path: ["FILTROAPP_ESCRITA"],
        message: "fora da produção, escrita no filtroAPP de produção só desligada ou simulada",
      });
    }
    if (env.EMAIL_ENVIO === "real") {
      ctx.addIssue({ code: "custom", path: ["EMAIL_ENVIO"], message: "fora da produção, e-mail só desligado ou em ensaio" });
    }
    if (env.PRISMA_OMNI_ENVIRONMENT !== "sandbox") {
      ctx.addIssue({ code: "custom", path: ["PRISMA_OMNI_ENVIRONMENT"], message: "fora da produção, só o sandbox do Prisma" });
    }
  });

export type WorkerEnv = z.infer<typeof schema>;

/** Valida as variáveis no boot e falha cedo, sem imprimir valores. */
export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const campos = parsed.error.issues.map((issue) => `${issue.path.join(".")}${issue.code === "custom" ? ` (${issue.message})` : ""}`).join(", ");
    throw new Error(`Variáveis de ambiente inválidas no worker: ${campos}`);
  }
  return parsed.data;
}
