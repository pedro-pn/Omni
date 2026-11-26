import { z } from "zod";

const onOff = z.enum(["on", "off"]).default("off");
/** O compose passa "" para variável não definida: vale como ausente. */
const opcional = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === "" ? undefined : v), t.optional());
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // Onde o Omni roda. Staging usa o build de produção (NODE_ENV=production), mas com as
    // mesmas travas do desenvolvimento: nada real sai para filtroAPP, Prisma, e-mail e WhatsApp.
    OMNI_AMBIENTE: z.enum(["desenvolvimento", "staging", "producao"]).optional(),
    APP_ORIGIN: z.url(),
    DATABASE_URL_APP: z.url({ protocol: /^postgres(ql)?$/ }),
    AUTH_SECRET: z.string().min(32),
    AUTH_DEV_LOGIN: onOff,
    ENTRA_LOGIN_ENABLED: onOff,
    ENTRA_TENANT_ID: z.string().optional(),
    ENTRA_CLIENT_ID: z.string().optional(),
    ENTRA_PRIVATE_KEY_PATH: z.string().optional(),
    ENTRA_CERT_SHA256_THUMBPRINT: z.string().optional(),
    ENTRA_CLIENT_SECRET: z.string().optional(),
    PRISMA_BASE_URL: z.url().default("https://prismacrm.filtrovali.com.br"),
    PRISMA_OMNI_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
    // Chave mestra das gravações cifradas no SharePoint (a mesma do worker).
    GRAVACOES_CHAVE_MESTRA: opcional(z.string().regex(/^[0-9a-f]{64}$/)),
    // Bloco "No Prisma" (lookup do contrato 1.67.0): mesma credencial `reader` do worker.
    PRISMA_OMNI_READER_TOKEN: opcional(z.string().regex(/^prisma_omni_reader_[a-f0-9]{64}$/)),
    // Envio de e-mail pelo Omni: "desligado", "ensaio" (monta e registra, não envia) ou "real" (só em produção).
    EMAIL_ENVIO: z.enum(["desligado", "ensaio", "real"]).default("ensaio"),
    // Caixa que manda os e-mails do sistema (avisos; no web, os links do login interno: 0078).
    EMAIL_AVISOS_REMETENTE: opcional(z.email()),
    // Microsoft Graph, app "Omni – Integrações" (Fase 4): opcional até ser configurado.
    GRAPH_TENANT_ID: z.string().optional(),
    GRAPH_CLIENT_ID: z.string().optional(),
    GRAPH_PRIVATE_KEY_PATH: z.string().optional(),
    GRAPH_CERT_SHA256_THUMBPRINT: z.string().optional(),
    // Biblioteca do site OmniAnexos (escrita): arquivos do Interno/Gerencial e gravações.
    GRAPH_ANEXOS_DRIVE_ID: opcional(z.string().regex(/^[A-Za-z0-9!_.,-]{10,300}$/)),
    // WhatsApp pela Evolution própria do Omni (ADR 0004): opcional até ser configurado.
    WHATSAPP_EVOLUTION_URL: opcional(z.url({ protocol: /^https?$/ })),
    WHATSAPP_EVOLUTION_KEY: opcional(z.string().min(32)),
    WHATSAPP_WEBHOOK_SECRET: opcional(z.string().min(32)),
    WHATSAPP_WEBHOOK_URL: opcional(z.url({ protocol: /^https?$/ })),
    // Envio pelo WhatsApp: "desligado", "ensaio" (registra, não envia) ou "real" (só em produção).
    WHATSAPP_ENVIO: z.enum(["desligado", "ensaio", "real"]).default("ensaio"),
    // Agenda das tarefas por link privado (.ics). Mesma chave do Foco para os links migrados continuarem valendo.
    APPLE_CALENDAR_SIGNING_KEY: opcional(z.string().min(32)),
    // PDF dos relatórios (spec 038): o servidor busca no filtroAPP na hora (só leitura; mesmo token do worker).
    FILTROAPP_API_URL: z.url({ protocol: /^https$/ }).default("https://app.filtrovali.com.br/api/integracoes/v1"),
    FILTROAPP_API_TOKEN: opcional(z.string().min(20)),
    CHAMADAS_HABILITADAS: onOff,
    CHAMADAS_SERVICO_URL: opcional(z.url({ protocol: /^http$/ })),
    CHAMADAS_SERVICO_KEY: opcional(z.string().min(32)),
    // Alertas pedidos à IA no Interno/Gerencial (@IA, /alerta): o pedido vai à OpenAI (retenção zero).
    IA_ALERTAS: z.enum(["desligada", "ligada"]).default("desligada"),
    OPENAI_API_KEY: opcional(z.string().min(20)),
    OPENAI_MODEL: z.string().min(3).default("gpt-6-luna"),
    /** Teto diário da IA (E11), o mesmo do worker: passou, nenhuma chamada ao modelo sai até a meia-noite. */
    IA_TETO_TOKENS_DIA: z.coerce.number().int().min(0).default(2_000_000),
    IA_TETO_CHAMADAS_DIA: z.coerce.number().int().min(0).default(3_000),
    // Notificações no celular (Web Push): a chave pública vai para o navegador; a privada fica só no worker.
    WEB_PUSH_PUBLIC_KEY: opcional(z.string().regex(/^[A-Za-z0-9_-]{80,100}$/)),
  })
  .superRefine((env, ctx) => {
    const ambiente = ambienteDe(env);
    // Serviço de voz: no desenvolvimento, no próprio computador (127.0.0.1); no staging e
    // na produção, pelo nome do serviço na rede interna do compose (ex.: http://voz:8098).
    let chamadasInterno = false;
    try {
      const u = new URL(env.CHAMADAS_SERVICO_URL ?? "");
      const nomeInterno = ambiente !== "desenvolvimento" && u.hostname !== "localhost" && /^[a-z][a-z0-9-]{0,62}$/.test(u.hostname);
      chamadasInterno = (u.hostname === "127.0.0.1" || nomeInterno) && !u.username && !u.password && !u.search && !u.hash;
    } catch { /* URL inválida: erro público abaixo. */ }
    if (env.CHAMADAS_HABILITADAS === "on" && (!chamadasInterno || !env.CHAMADAS_SERVICO_KEY)) {
      ctx.addIssue({ code: "custom", path: ["CHAMADAS_SERVICO_URL"], message: "chamadas exigem serviço interno e chave interna" });
    }
    if (env.OMNI_AMBIENTE === "producao" && env.NODE_ENV !== "production") {
      ctx.addIssue({ code: "custom", path: ["OMNI_AMBIENTE"], message: "produção exige NODE_ENV=production" });
    }
    if ((env.NODE_ENV === "production" || ambiente !== "desenvolvimento") && env.AUTH_DEV_LOGIN === "on") {
      ctx.addIssue({ code: "custom", path: ["AUTH_DEV_LOGIN"], message: "proibido em produção e em staging" });
    }
    // Fora da produção do Omni (desenvolvimento e staging), as escritas no Prisma só vão para o sandbox.
    if (ambiente !== "producao" && env.PRISMA_OMNI_ENVIRONMENT !== "sandbox") {
      ctx.addIssue({ code: "custom", path: ["PRISMA_OMNI_ENVIRONMENT"], message: "fora da produção, só o sandbox do Prisma" });
    }
    // Fora da produção do Omni, nenhum e-mail sai de verdade.
    if (ambiente !== "producao" && env.EMAIL_ENVIO === "real") {
      ctx.addIssue({ code: "custom", path: ["EMAIL_ENVIO"], message: "fora da produção, envio de e-mail só desligado ou em ensaio" });
    }
    // Fora da produção do Omni, nenhuma mensagem de WhatsApp sai de verdade.
    if (ambiente !== "producao" && env.WHATSAPP_ENVIO === "real") {
      ctx.addIssue({ code: "custom", path: ["WHATSAPP_ENVIO"], message: "fora da produção, envio pelo WhatsApp só desligado ou em ensaio" });
    }
    const whatsapp = [env.WHATSAPP_EVOLUTION_URL, env.WHATSAPP_EVOLUTION_KEY, env.WHATSAPP_WEBHOOK_SECRET, env.WHATSAPP_WEBHOOK_URL];
    if (whatsapp.some(Boolean) && !whatsapp.every(Boolean)) {
      ctx.addIssue({ code: "custom", path: ["WHATSAPP_EVOLUTION_URL"], message: "WhatsApp: informe as quatro variáveis WHATSAPP_* ou nenhuma" });
    }
    if (env.WHATSAPP_EVOLUTION_KEY && env.WHATSAPP_EVOLUTION_KEY === env.WHATSAPP_WEBHOOK_SECRET) {
      ctx.addIssue({ code: "custom", path: ["WHATSAPP_WEBHOOK_SECRET"], message: "use um segredo diferente da chave da Evolution" });
    }
    if (env.NODE_ENV === "production" && !env.APP_ORIGIN.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "precisa ser https em produção" });
    }
    const graph = [env.GRAPH_TENANT_ID, env.GRAPH_CLIENT_ID, env.GRAPH_PRIVATE_KEY_PATH, env.GRAPH_CERT_SHA256_THUMBPRINT];
    if (graph.some(Boolean)) {
      if (!graph.every(Boolean)) ctx.addIssue({ code: "custom", path: ["GRAPH_CLIENT_ID"], message: "Graph: informe as quatro variáveis ou nenhuma" });
      if (env.GRAPH_TENANT_ID && !uuid.safeParse(env.GRAPH_TENANT_ID).success) {
        ctx.addIssue({ code: "custom", path: ["GRAPH_TENANT_ID"], message: "UUID obrigatório" });
      }
      if (env.GRAPH_CLIENT_ID && !uuid.safeParse(env.GRAPH_CLIENT_ID).success) {
        ctx.addIssue({ code: "custom", path: ["GRAPH_CLIENT_ID"], message: "UUID obrigatório" });
      }
      if (env.GRAPH_CERT_SHA256_THUMBPRINT && !/^[a-f0-9]{64}$/i.test(env.GRAPH_CERT_SHA256_THUMBPRINT)) {
        ctx.addIssue({ code: "custom", path: ["GRAPH_CERT_SHA256_THUMBPRINT"], message: "SHA-256 obrigatório" });
      }
    }
    if (env.ENTRA_LOGIN_ENABLED === "on") {
      if (!uuid.safeParse(env.ENTRA_TENANT_ID).success) {
        ctx.addIssue({ code: "custom", path: ["ENTRA_TENANT_ID"], message: "UUID obrigatório" });
      }
      if (!uuid.safeParse(env.ENTRA_CLIENT_ID).success) {
        ctx.addIssue({ code: "custom", path: ["ENTRA_CLIENT_ID"], message: "UUID obrigatório" });
      }
      const hasCert = Boolean(env.ENTRA_PRIVATE_KEY_PATH);
      const hasSecret = Boolean(env.ENTRA_CLIENT_SECRET);
      if (hasCert === hasSecret) {
        ctx.addIssue({ code: "custom", path: ["ENTRA_CLIENT_SECRET"], message: "use certificado OU segredo" });
      }
      if (hasCert && !/^[a-f0-9]{64}$/i.test(env.ENTRA_CERT_SHA256_THUMBPRINT ?? "")) {
        ctx.addIssue({ code: "custom", path: ["ENTRA_CERT_SHA256_THUMBPRINT"], message: "SHA-256 obrigatório" });
      }
    }
  });

export type WebEnv = z.infer<typeof schema>;

/** Ambiente efetivo: o declarado, ou o que o NODE_ENV indica (production → produção). */
export function ambienteDe(env: { OMNI_AMBIENTE?: "desenvolvimento" | "staging" | "producao"; NODE_ENV: string }) {
  return env.OMNI_AMBIENTE ?? (env.NODE_ENV === "production" ? "producao" : "desenvolvimento");
}

let cached: WebEnv | undefined;

/** Valida um conjunto de variáveis (usado no boot e nos testes); erro sem os valores. */
export function validarEnvWeb(source: Record<string, string | undefined>): WebEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const campos = parsed.error.issues.map((issue) => `${issue.path.join(".")} (${issue.message})`).join(", ");
    throw new Error(`Variáveis de ambiente inválidas no web: ${campos}`);
  }
  return parsed.data;
}

/** Valida no primeiro uso e falha cedo, sem imprimir valores. */
export function getEnv(): WebEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const campos = parsed.error.issues.map((issue) => `${issue.path.join(".")} (${issue.message})`).join(", ");
    throw new Error(`Variáveis de ambiente inválidas no web: ${campos}`);
  }
  cached = parsed.data;
  return cached;
}

export function isSecureOrigin(): boolean {
  return getEnv().APP_ORIGIN.startsWith("https://");
}
