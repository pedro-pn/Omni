import type { z } from "zod";

import {
  alocacaoSchema,
  collectionSchema,
  condicoesSchema,
  custoProjetoSchema,
  servicosDoProjetoSchema,
  type ServicosDoProjeto,
  descargaSchema,
  erroSchema,
  eventoSchema,
  medicaoSchema,
  notaSchema,
  novaDescargaSchema,
  pendenciaSchema,
  pontoSemanaSchema,
  registroQualidadeSchema,
  semanaAcompanhamentoSchema,
  romaneioSchema,
  novoRegistroQualidadeSchema,
  registroCriadoSchema,
  relatorioSchema,
  colaboradorSchema,
  projetoSchema,
  responsavelSchema,
  statusColecaoSchema,
  statusProjetoSchema,
  type Alocacao,
  type Condicoes,
  type CustoProjeto,
  type Descarga,
  type Evento,
  type Medicao,
  type Nota,
  type NovaDescarga,
  type NovoRegistroQualidade,
  type Pendencia,
  type PontoSemana,
  type RegistroQualidade,
  type Romaneio,
  type SemanaAcompanhamento,
  type Projeto,
  type RegistroCriado,
  type Relatorio,
  type Colaborador,
  type Responsavel,
  type StatusColecao,
  type StatusProjeto,
} from "./schemas.ts";

/**
 * Cliente somente leitura da API de integrações do filtroAPP.
 *
 * - Limite do token: 60 req/min (filtroAPP `quota.js`). As chamadas saem em
 *   fila, com intervalo mínimo entre elas (padrão 1,1 s ≈ 54/min).
 * - 429: espera o `Retry-After` (+ jitter) e tenta de novo.
 * - 5xx/rede: até 3 novas tentativas com backoff.
 * - O token nunca aparece em mensagens de erro nem em log.
 */

export class FiltroAppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "FiltroAppError";
  }
}

/**
 * Modo de escrita no filtroAPP (vale para TODA rota que grava):
 * - "desligada": o cliente recusa qualquer escrita (o chamador registra só no Omni);
 * - "simulada": envia `Prefer: validate-only`; o filtroAPP valida com os dados
 *   reais e não grava nada. Sem a confirmação dele, a resposta é tratada como erro;
 * - "real": grava. Fora da produção do Omni, a validação do ambiente recusa
 *   "real" contra o filtroAPP de produção.
 */
export type ModoEscrita = "desligada" | "simulada" | "real";

export class EscritaDesligadaError extends Error {
  constructor() {
    super("Escrita no filtroAPP desligada neste ambiente (FILTROAPP_ESCRITA=desligada)");
    this.name = "EscritaDesligadaError";
  }
}

export type ResultadoEscrita<T> = { simulado: true; previa: unknown } | { simulado: false; resultado: T };

export type FiltroAppClientOptions = {
  baseUrl: string;
  token: string;
  /** Padrão: "desligada". */
  escrita?: ModoEscrita;
  /** Intervalo mínimo entre chamadas, em ms. */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  pageSize?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FiltroAppClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly pageSize: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  readonly escrita: ModoEscrita;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(options: FiltroAppClientOptions) {
    if (!options.token) throw new Error("Token do filtroAPP ausente");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.minIntervalMs = options.minIntervalMs ?? 1100;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.pageSize = options.pageSize ?? 100;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.escrita = options.escrita ?? "desligada";
  }

  /** Todos os projetos (paginando). `updatedSince` para sincronização incremental. */
  async listProjetos(params: { updatedSince?: Date; active?: boolean } = {}): Promise<Projeto[]> {
    const query = new URLSearchParams({ limit: String(this.pageSize) });
    if (params.updatedSince) query.set("updatedSince", params.updatedSince.toISOString());
    if (params.active !== undefined) query.set("active", String(params.active));
    return this.collect("/projetos", query, projetoSchema);
  }

  /** Responsáveis (líder de projetos, gestor de contrato, líder de campo) de todos os projetos. */
  async listResponsaveis(): Promise<Responsavel[]> {
    return this.collect("/projetos/responsaveis", new URLSearchParams({ limit: String(this.pageSize) }), responsavelSchema);
  }

  /**
   * Status do workflow de vários projetos (em vez de uma chamada por projeto).
   * Páginas de 100 de novo desde a correção do filtroAPP de 05/11/2026 (o 500
   * com páginas grandes acabou; ~5,5 s para todos os projetos, contra ~16 s em páginas de 10).
   */
  async listStatus(params: { active?: boolean } = {}): Promise<StatusColecao[]> {
    const query = new URLSearchParams({ limit: String(this.pageSize) });
    if (params.active !== undefined) query.set("active", String(params.active));
    return this.collect("/efetivo/projetos/status", query, statusColecaoSchema);
  }

  /**
   * Uma página do feed de eventos. Guarde o `nextCursor` mesmo sem itens.
   * Cursor fora da retenção (30 dias) → FiltroAppError 410 `CURSOR_EXPIRED`.
   */
  async listEventos(cursor: string | null): Promise<{ itens: Evento[]; nextCursor: string | null; hasMore: boolean }> {
    // Mesmo tamanho das outras leituras: o máximo vem da credencial (padrão do filtroAPP: 100).
    const query = new URLSearchParams({ limit: String(this.pageSize) });
    if (cursor) query.set("cursor", cursor);
    const body = collectionSchema(eventoSchema).parse(await this.request(`/eventos?${query}`));
    return { itens: body.items, nextCursor: body.page.nextCursor ?? cursor, hasMore: body.page.hasMore };
  }

  /** Relatórios em todos os estados (exige `rdo.relatorios.todos.read`). */
  async listRelatorios(params: { updatedSince?: Date } = {}): Promise<Relatorio[]> {
    const query = new URLSearchParams({ limit: String(this.pageSize), status: "PENDING,RETURNED,APPROVED,SIGNED" });
    if (params.updatedSince) query.set("updatedSince", params.updatedSince.toISOString());
    return this.collect("/rdo/relatorios", query, relatorioSchema);
  }

  /** Colaboradores com o e-mail corporativo (spec 038), para ligar a alocação à conta do Omni. */
  async listColaboradores(): Promise<Colaborador[]> {
    return this.collect("/colaboradores", new URLSearchParams({ limit: String(this.pageSize) }), colaboradorSchema);
  }

  /**
   * Arquivo binário (spec 038): PDF de um relatório ou documento de manutenção.
   * Devolve a resposta crua do filtroAPP para o servidor repassar em streaming;
   * 404, 409 `PDF_NOT_READY` (com Retry-After), 413 e 403 chegam como estão.
   */
  async arquivo(tipo: "relatorio" | "manutencao", id: string): Promise<Response> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new FiltroAppError("Identificador inválido", 400, "INVALID_ID");
    const caminho = tipo === "relatorio" ? `/rdo/relatorios/${encodeURIComponent(id)}/pdf` : `/manutencao/anexos/${encodeURIComponent(id)}/download`;
    const run = this.queue.then(async () => {
      const espera = this.lastCallAt + this.minIntervalMs - this.now();
      if (espera > 0) await this.sleep(espera);
      this.lastCallAt = this.now();
      return this.fetchImpl(`${this.baseUrl}${caminho}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/pdf, application/octet-stream" },
        signal: AbortSignal.timeout(60_000),
      });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- Entrega B (spec 034)

  private incremental(params: { updatedSince?: Date }) {
    const query = new URLSearchParams({ limit: String(this.pageSize) });
    if (params.updatedSince) query.set("updatedSince", params.updatedSince.toISOString());
    return query;
  }

  /** Medição por projeto (`efetivo.projetos.medicao.read`; valores com `.valores.read`). */
  async listMedicoes(params: { updatedSince?: Date } = {}): Promise<Medicao[]> {
    return this.collect("/efetivo/projetos/medicoes", this.incremental(params), medicaoSchema);
  }

  /** Notas fiscais ligadas a projeto (`omie.notas.read`). */
  async listNotas(params: { updatedSince?: Date } = {}): Promise<Nota[]> {
    return this.collect("/omie/notas", this.incremental(params), notaSchema);
  }

  /** Romaneios de saída e de retorno (`romaneios.read`). */
  async listRomaneios(params: { updatedSince?: Date } = {}): Promise<Romaneio[]> {
    return this.collect("/romaneios", this.incremental(params), romaneioSchema);
  }

  /** Pendências a pagar/receber agregadas por projeto (`omie.pendencias.read`). */
  async listPendencias(params: { updatedSince?: Date } = {}): Promise<Pendencia[]> {
    return this.collect("/omie/projetos/pendencias", this.incremental(params), pendenciaSchema);
  }

  /** Registros da Qualidade, inclusive excluídos (para tirá-los do Omni também). */
  async listRegistrosQualidade(params: { updatedSince?: Date } = {}): Promise<RegistroQualidade[]> {
    const query = this.incremental(params);
    query.set("limit", "100"); // a Qualidade aceita no máximo 100 por página
    query.set("includeDeleted", "true");
    return this.collect("/qualidade/registros", query, registroQualidadeSchema);
  }

  /** Confirmações de chegada e descarga (`logistica.descargas.read`). */
  async listDescargas(params: { updatedSince?: Date } = {}): Promise<Descarga[]> {
    return this.collect("/logistica/descargas", this.incremental(params), descargaSchema);
  }

  // ---------------------------------------------------------------- Gestão (spec 034, B6)

  private periodo(semanas: { from: string; to: string }) {
    return new URLSearchParams({ limit: String(this.pageSize), from: semanas.from, to: semanas.to });
  }

  /** Avanço, meta e revisão por projeto e semana (`acompanhamento.progresso.read`). `from`/`to`: segundas, até 12 semanas. */
  async listSemanasAcompanhamento(semanas: { from: string; to: string }): Promise<SemanaAcompanhamento[]> {
    return this.collect("/acompanhamento/projetos/semanas", this.periodo(semanas), semanaAcompanhamentoSchema);
  }

  /** Composição do avanço por serviço e equipamento (`acompanhamento.progresso.read`). */
  async listServicos(): Promise<ServicosDoProjeto[]> {
    return this.collect("/acompanhamento/projetos/servicos", new URLSearchParams({ limit: "50" }), servicosDoProjetoSchema);
  }

  /**
   * Custos × avanço por projeto (`acompanhamento.custos.read`). O cálculo é
   * pesado no filtroAPP: páginas de 10 (100 por página estoura o tempo).
   */
  async listCustos(): Promise<CustoProjeto[]> {
    return this.collect("/acompanhamento/projetos/custos", new URLSearchParams({ limit: "10" }), custoProjetoSchema);
  }

  /** Permanência prevista e, com `projetos.condicoes.valores.read`, a diária de stand-by. */
  async listCondicoes(params: { updatedSince?: Date } = {}): Promise<Condicoes[]> {
    return this.collect("/projetos/condicoes", this.incremental(params), condicoesSchema);
  }

  /** Alocações do Efetivo, inclusive excluídas (`efetivo.alocacoes.read`). */
  async listAlocacoes(params: { updatedSince?: Date } = {}): Promise<Alocacao[]> {
    return this.collect("/efetivo/alocacoes", this.incremental(params), alocacaoSchema);
  }

  /** Horas do ponto por projeto e semana, só agregadas (`ponto.resumos.read`). */
  async listPontoSemanas(semanas: { from: string; to: string }): Promise<PontoSemana[]> {
    return this.collect("/ponto/projetos/semanas", this.periodo(semanas), pontoSemanaSchema);
  }

  /**
   * Confirma chegada/descarga de um romaneio de saída (`logistica.descargas.create`).
   * Idempotente pela chave; TOTAL repetido devolve o registro original.
   */
  async criarDescarga(corpo: NovaDescarga, idempotencyKey: string): Promise<ResultadoEscrita<Descarga>> {
    const body = novaDescargaSchema.parse(corpo);
    const r = await this.gravar("/logistica/descargas", body, { "Idempotency-Key": idempotencyKey });
    return r.simulado ? r : { simulado: false, resultado: descargaSchema.parse(r.resultado) };
  }

  /**
   * Abre registro na Qualidade. Idempotente: repita com a MESMA chave e o MESMO
   * corpo após falha de rede/5xx; o filtroAPP devolve o resultado original.
   */
  async criarRegistroQualidade(corpo: NovoRegistroQualidade, idempotencyKey: string): Promise<ResultadoEscrita<RegistroCriado>> {
    const body = novoRegistroQualidadeSchema.parse(corpo);
    const r = await this.gravar("/qualidade/registros", body, { "Idempotency-Key": idempotencyKey });
    return r.simulado ? r : { simulado: false, resultado: registroCriadoSchema.parse(r.resultado) };
  }

  /** Único caminho de escrita: aplica o modo e confere a simulação. */
  private async gravar(path: string, corpo: unknown, headers: Record<string, string>): Promise<ResultadoEscrita<unknown>> {
    if (this.escrita === "desligada") throw new EscritaDesligadaError();
    const simular = this.escrita === "simulada";
    const resposta = await this.requestComCabecalhos(path, {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "Content-Type": "application/json", ...headers, ...(simular ? { Prefer: "validate-only" } : {}) },
    });
    const confirmou =
      /\bvalidate-only\b/.test(resposta.headers.get("preference-applied") ?? "") &&
      (resposta.body as { simulated?: unknown } | null)?.simulated === true;
    if (simular) {
      if (!confirmou) {
        throw new FiltroAppError(
          `filtroAPP não confirmou a simulação em ${path}: trate como possível gravação e confira no filtroAPP`,
          0,
          "SIMULATION_NOT_CONFIRMED",
        );
      }
      return { simulado: true, previa: resposta.body };
    }
    if (confirmou) throw new FiltroAppError(`filtroAPP simulou uma escrita real em ${path}`, 0, "UNEXPECTED_SIMULATION");
    return { simulado: false, resultado: resposta.body };
  }

  /** Situação do workflow; `null` quando o filtroAPP responde 404 (projeto sem registro de workflow). */
  async getStatusProjeto(projectId: string): Promise<StatusProjeto | null> {
    try {
      const body = await this.request(`/efetivo/projetos/${encodeURIComponent(projectId)}/status`);
      return statusProjetoSchema.parse(body);
    } catch (error) {
      if (error instanceof FiltroAppError && error.status === 404) return null;
      throw error;
    }
  }

  private async collect<T extends z.ZodType>(path: string, query: URLSearchParams, item: T): Promise<z.infer<T>[]> {
    const schema = collectionSchema(item);
    const out: z.infer<T>[] = [];
    let cursor: string | null | undefined;
    do {
      const pageQuery = new URLSearchParams(query);
      if (cursor) pageQuery.set("cursor", cursor);
      const body = schema.parse(await this.request(`${path}?${pageQuery}`));
      out.push(...body.items);
      cursor = body.page.hasMore ? body.page.nextCursor : null;
    } while (cursor);
    return out;
  }

  /** Serializa as chamadas para respeitar o intervalo mínimo. */
  private async request(path: string): Promise<unknown> {
    return (await this.requestComCabecalhos(path, {})).body;
  }

  private requestComCabecalhos(
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> },
  ): Promise<{ body: unknown; headers: Headers }> {
    const run = this.queue.then(() => this.requestWithRetry(path, init));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async requestWithRetry(
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> },
  ): Promise<{ body: unknown; headers: Headers }> {
    for (let attempt = 0; ; attempt += 1) {
      const wait = this.lastCallAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCallAt = this.now();

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: init.method ?? "GET",
          body: init.body,
          headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...init.headers },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new FiltroAppError(`Falha de rede no filtroAPP (${(error as Error).name})`, 0);
      }

      if (response.ok) return { body: await response.json(), headers: response.headers };

      const parsed = erroSchema.safeParse(await response.json().catch(() => ({})));
      const err = parsed.success ? parsed.data : {};
      if (response.status === 429 && attempt < this.maxRetries + 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 10;
        await this.sleep(seconds * 1000 + Math.floor(Math.random() * 500));
        continue;
      }
      if (response.status >= 500 && attempt < this.maxRetries) {
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new FiltroAppError(
        `filtroAPP respondeu ${response.status}${err.code ? ` (${err.code})` : ""} em ${path.split("?")[0]}`,
        response.status,
        err.code,
        err.requestId,
      );
    }
  }
}
