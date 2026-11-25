import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { eventoPrismaSchema, type EventoPrisma } from "./schemas.ts";

/**
 * Integração Prisma CRM → Omni (contrato 1.66.0, `crm-filtrovali/docs/prisma-omni.md`).
 *
 * - Leitura: token `reader` da aplicação (só no servidor), coleções com cursor
 *   opaco e `updated_since`, feed `events`. Limite: 120 req/min por credencial.
 * - Escrita: credencial individual por Authorization Code + PKCE S256, cliente
 *   fixo `omni`, sem refresh. Validade: 3 meses de calendário desde a emissão
 *   (Prisma 1.64.1); o vencimento vem sempre do `expires_in`, nunca de um prazo fixo.
 * - O token nunca aparece em mensagens de erro nem em log.
 */

export const PRISMA_BASE_URL = "https://prismacrm.filtrovali.com.br";
export const PRISMA_ESCOPOS = ["contacts.write", "companies.write", "feedback.write", "missions.participants.write"] as const;
export type PrismaAmbiente = "sandbox" | "production";
export type PrismaRecurso = "contacts" | "companies" | "deals" | "feedback" | "missions" | "users" | "pipelines";

export class PrismaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "PrismaError";
  }
}

// ---------------------------------------------------------------- PKCE

export type FluxoPkce = { state: string; verifier: string; challenge: string };

/** state: 43 caracteres base64url (o Prisma aceita 16–200 de A-Z a-z 0-9 _ . ~ -). */
export function novoFluxoPkce(): FluxoPkce {
  const verifier = randomBytes(32).toString("base64url");
  return {
    state: randomBytes(32).toString("base64url"),
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

export function urlAutorizacao(params: {
  baseUrl?: string;
  environment: PrismaAmbiente;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes?: readonly string[];
}): string {
  const url = new URL("/api/omni/oauth/authorize", params.baseUrl ?? PRISMA_BASE_URL);
  // Exatamente os 8 parâmetros que o Prisma aceita (validateOmniAuthorization).
  url.search = new URLSearchParams({
    client_id: "omni",
    response_type: "code",
    environment: params.environment,
    redirect_uri: params.redirectUri,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    state: params.state,
    scope: (params.scopes ?? PRISMA_ESCOPOS).join(" "),
  }).toString();
  return url.toString();
}

const tokenSchema = z.object({
  access_token: z.string().regex(/^prisma_omni_user_[a-f0-9]{64}$/),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  scope: z.string(),
  environment: z.enum(["sandbox", "production"]),
});

export type CredencialPrisma = {
  accessToken: string;
  expiresAt: Date;
  scopes: string[];
  environment: PrismaAmbiente;
};

export async function trocarCodigo(params: {
  baseUrl?: string;
  code: string;
  verifier: string;
  redirectUri: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<CredencialPrisma> {
  const fetchImpl = params.fetch ?? fetch;
  const response = await fetchImpl(new URL("/api/omni/oauth/token", params.baseUrl ?? PRISMA_BASE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: "omni",
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const erro = (body ?? {}) as { error?: string; requestId?: string };
    throw new PrismaError(`Prisma recusou a troca do código (${response.status})`, response.status, erro.error, erro.requestId);
  }
  const token = tokenSchema.parse(body);
  const agora = (params.now ?? (() => new Date()))();
  return {
    accessToken: token.access_token,
    expiresAt: new Date(agora.getTime() + token.expires_in * 1000),
    scopes: token.scope.split(" ").filter(Boolean),
    environment: token.environment,
  };
}

// ---------------------------------------------------------------- consultas

const lookupSchema = z.object({
  data: z.array(
    z.object({
      contact: z.object({ id: z.string(), canonicalId: z.string().nullable().optional(), name: z.string().nullable().optional(), title: z.string().nullable().optional(), emails: z.array(z.string()).optional(), phones: z.array(z.string()).optional(), ownerId: z.string().nullable().optional() }).passthrough(),
      company: z.object({ id: z.string(), name: z.string().nullable().optional() }).nullable(),
      companies: z.array(z.object({ id: z.string(), name: z.string().nullable().optional() })).optional().default([]),
      openDeals: z.array(z.object({ id: z.string(), title: z.string().nullable().optional(), stageId: z.string().nullable().optional(), ownerId: z.string().nullable().optional(), missionId: z.string().nullable().optional() })).optional().default([]),
      feedback: z
        .array(z.object({ id: z.string(), text: z.string().nullable().optional(), source: z.string().nullable().optional(), occurredAt: z.string().nullable().optional(), actorName: z.string().nullable().optional() }).passthrough())
        .optional()
        .default([]),
    }),
  ),
  ambiguous: z.boolean(),
});
export type ResultadoLookup = z.infer<typeof lookupSchema>["data"][number];

const capabilitiesSchema = z.object({
  data: z.object({
    environment: z.enum(["sandbox", "production"]),
    purpose: z.enum(["reader", "user"]),
    userId: z.string().nullable(),
    actorId: z.string().nullable(),
    scopes: z.array(z.string()),
    resources: z.array(z.string()),
    limits: z.object({ requestsPerMinute: z.number(), rowsPerDay: z.number(), pageSize: z.number(), batchSize: z.number() }),
  }),
  revision: z.union([z.string(), z.number()]).nullable(),
  requestId: z.string(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

const paginaSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.unknown().nullable().optional(),
  highWatermark: z.string().nullable().optional(),
  requestId: z.string(),
});

export type PrismaClientOptions = {
  token: string;
  environment: PrismaAmbiente;
  baseUrl?: string;
  /** Intervalo mínimo entre chamadas: 550 ms ≈ 109/min (limite 120). */
  minIntervalMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PrismaClient {
  private readonly base: string;
  private readonly token: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(options: PrismaClientOptions) {
    if (!/^prisma_omni_(reader|user)_[a-f0-9]{64}$/.test(options.token)) throw new Error("Token do Prisma inválido");
    this.base = `${(options.baseUrl ?? PRISMA_BASE_URL).replace(/\/+$/, "")}/api/omni/v1/${options.environment}`;
    this.token = options.token;
    this.minIntervalMs = options.minIntervalMs ?? 550;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  async capabilities(): Promise<Capabilities> {
    return capabilitiesSchema.parse(await this.request("/capabilities"));
  }

  /**
   * Lê todas as páginas de uma coleção (só o token `reader`). O cursor é um
   * objeto opaco que o Prisma recebe de volta em JSON codificado em base64url.
   */
  async listar(recurso: PrismaRecurso, filtros: { updatedSince?: Date } = {}): Promise<{ itens: Record<string, unknown>[]; highWatermark: string | null }> {
    const itens: Record<string, unknown>[] = [];
    let cursor: unknown = null;
    let highWatermark: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (filtros.updatedSince) query.set("updated_since", filtros.updatedSince.toISOString());
      if (cursor) query.set("cursor", typeof cursor === "string" ? cursor : Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url"));
      const pagina = paginaSchema.parse(await this.request(`/${recurso}?${query}`));
      itens.push(...pagina.data);
      highWatermark ??= pagina.highWatermark ?? null;
      cursor = pagina.data.length > 0 ? (pagina.nextCursor ?? null) : null;
    } while (cursor);
    return { itens, highWatermark };
  }

  /**
   * Uma página do feed de eventos a partir do cursor (decimal em texto; "0" = início).
   * `nextCursor` é o último lido; sem eventos novos, volta o mesmo cursor.
   */
  async eventos(cursor: string, limit = 100): Promise<{ itens: EventoPrisma[]; nextCursor: string; highWatermark: string }> {
    const query = new URLSearchParams({ cursor, limit: String(limit) });
    const pagina = z
      .object({ data: z.array(eventoPrismaSchema), nextCursor: z.string(), highWatermark: z.string() })
      .parse(await this.request(`/events?${query}`));
    return { itens: pagina.data, nextCursor: pagina.nextCursor, highWatermark: pagina.highWatermark };
  }

  // ---------------------------------------------------------------- Fase 6 (contrato 1.67.0)

  /**
   * Quem é este e-mail ou telefone (só o `reader`): contato, empresa, oportunidades
   * abertas e os últimos feedbacks. Vários candidatos vêm todos (`ambiguous`).
   */
  async lookup(identidade: { email: string } | { phone: string }, feedbackLimit = 5): Promise<{ itens: ResultadoLookup[]; ambiguous: boolean }> {
    const query = new URLSearchParams("email" in identidade ? { email: identidade.email } : { phone: identidade.phone });
    query.set("feedbackLimit", String(Math.min(Math.max(feedbackLimit, 1), 100)));
    const r = lookupSchema.parse(await this.request(`/contacts/lookup?${query}`));
    return { itens: r.data, ambiguous: r.ambiguous };
  }

  /** Revisão atual para a próxima escrita (`If-Match`); só o token da pessoa. */
  async revisao(): Promise<number> {
    const c = await this.capabilities();
    const r = c.revision == null ? NaN : Number(c.revision);
    if (!Number.isSafeInteger(r)) throw new PrismaError("Sem revisão: escrita exige o token da pessoa", 403, "delegated_user_required");
    return r;
  }

  /** POST com `Idempotency-Key` e `If-Match`; devolve o resultado e a revisão nova. */
  private async escrever<T>(path: string, corpo: unknown, opcoes: { chave: string; revisao: number }): Promise<{ dados: T; revisao: number | null }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(opcoes.chave)) throw new PrismaError("Chave de idempotência inválida", 400, "idempotency_key_required");
    const r = (await this.request(path, { method: "POST", body: JSON.stringify(corpo), chave: opcoes.chave, revisao: opcoes.revisao })) as { data: T; revision?: number | string };
    const nova = r.revision == null ? NaN : Number(r.revision);
    return { dados: r.data, revisao: Number.isSafeInteger(nova) ? nova : null };
  }

  /** Cria ou completa um contato (só preenche lacunas; 409 em conflito de identidade ou de empresa). */
  upsertContato(c: { name: string; email?: string; phone?: string; title?: string; companyId?: string }, opcoes: { chave: string; revisao: number }) {
    return this.escrever<{ id: string; created: boolean }>("/contacts/upsert", c, opcoes);
  }

  /** Participante do cliente na missão (a empresa precisa ser da missão e a pessoa, da empresa). */
  vincularParticipante(missaoId: string, p: { contactId: string; companyId: string }, opcoes: { chave: string; revisao: number }) {
    return this.escrever<{ missionId: string; contactId: string }>(`/missions/${encodeURIComponent(missaoId)}/participants`, { ...p, role: "customer" }, opcoes);
  }

  /** Tira só o vínculo do Omni (contato, oportunidades e histórico ficam). */
  removerParticipante(missaoId: string, contatoId: string, opcoes: { chave: string; revisao: number }) {
    return this.escrever<unknown>(`/missions/${encodeURIComponent(missaoId)}/participants/${encodeURIComponent(contatoId)}/remove`, {}, opcoes);
  }

  /** Feedback em nome da pessoa do token (ligação, e-mail, WhatsApp ou reunião). */
  registrarFeedback(
    f: { text: string; kind: "feedback" | "activity" | "incident"; source: "whatsapp" | "email" | "call" | "meeting"; occurredAt: string; sourceUrl: string; contactId?: string; dealId?: string; companyId?: string },
    opcoes: { chave: string; revisao: number },
  ) {
    return this.escrever<{ id: string }>("/feedback", f, opcoes);
  }

  private request(path: string, escrita?: { method: "POST"; body: string; chave: string; revisao: number }): Promise<unknown> {
    const run = this.queue.then(() => this.requestWithRetry(path, escrita));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async requestWithRetry(path: string, escrita?: { method: "POST"; body: string; chave: string; revisao: number }): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const wait = this.lastCallAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCallAt = this.now();
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.base}${path}`, {
          // User-Agent explícito: o Cloudflare do Prisma recusa alguns agentes genéricos.
          method: escrita?.method ?? "GET",
          body: escrita?.body,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            "User-Agent": "omni-filtrovali",
            ...(escrita ? { "Content-Type": "application/json", "Idempotency-Key": escrita.chave, "If-Match": `"${escrita.revisao}"` } : {}),
          },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new PrismaError(`Falha de rede no Prisma (${(error as Error).name})`, 0);
      }
      if (response.ok) return response.json();
      const bruto = ((await response.json().catch(() => ({}))) ?? {}) as { error?: string | { code?: string }; requestId?: string };
      // Erro como `{error: {code}}` (contrato) ou texto (versões antigas).
      const body = { error: typeof bruto.error === "string" ? bruto.error : bruto.error?.code, requestId: bruto.requestId };
      if (response.status === 429 && attempt < this.maxRetries + 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await this.sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30) * 1000 + Math.floor(Math.random() * 500));
        continue;
      }
      // Escrita com 5xx não se repete aqui: a mesma chave de idempotência pode ser reenviada depois, sem duplicar.
      if (response.status >= 500 && attempt < this.maxRetries && !escrita) {
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new PrismaError(
        `Prisma respondeu ${response.status}${body.error ? ` (${body.error})` : ""} em ${path.split("?")[0]}`,
        response.status,
        body.error,
        body.requestId,
      );
    }
  }
}
