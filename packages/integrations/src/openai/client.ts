import { z } from "zod";

/**
 * API da OpenAI para a IA v2 (ADR 0005): Responses API com saída estruturada
 * (JSON Schema estrito), `store: false` e a organização com retenção zero.
 * Chamada HTTP direta (sem SDK), atrás da interface `Llm` do Omni para poder
 * trocar de provedor. A chave nunca aparece em erros nem em log.
 */

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export type RespostaLlm<T> = { dados: T; modelo: string; tokensEntrada: number; tokensSaida: number; duracaoMs: number };

/** O que o Omni usa de um LLM (qualquer provedor). */
export interface Llm {
  estruturado<T>(p: { modelo: string; sistema: string; entrada: string; nome: string; esquema: Record<string, unknown> }): Promise<RespostaLlm<T>>;
}

/** Transcrição de áudio (resumo das ligações gravadas). O texto não é guardado pelo Omni. */
export interface Transcritor {
  transcrever(p: { modelo: string; audio: Uint8Array; nomeArquivo: string; tipo: string; idioma?: string }): Promise<{ texto: string; modelo: string; duracaoMs: number }>;
}

export type OpenAiOptions = { apiKey: string; baseUrl?: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; maxRetries?: number };

const respostaSchema = z.object({
  model: z.string(),
  status: z.string().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullable().optional(),
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional(), refusal: z.string().optional() })).optional(),
    }),
  ),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OpenAiClient implements Llm, Transcritor {
  private readonly o: Required<Omit<OpenAiOptions, "fetch" | "sleep" | "now">> & Pick<OpenAiOptions, "fetch" | "sleep" | "now">;

  constructor(options: OpenAiOptions) {
    if (!options.apiKey || options.apiKey.length < 20) throw new Error("Chave da OpenAI inválida");
    this.o = { baseUrl: "https://api.openai.com/v1", maxRetries: 2, ...options };
  }

  /** POST /audio/transcriptions (multipart), em português; mesmas novas tentativas do `estruturado`. */
  async transcrever(p: { modelo: string; audio: Uint8Array; nomeArquivo: string; tipo: string; idioma?: string }): Promise<{ texto: string; modelo: string; duracaoMs: number }> {
    const fetchImpl = this.o.fetch ?? fetch;
    const sleep = this.o.sleep ?? defaultSleep;
    const now = this.o.now ?? Date.now;
    const inicio = now();
    for (let tentativa = 0; ; tentativa += 1) {
      const form = new FormData();
      form.set("model", p.modelo);
      form.set("language", p.idioma ?? "pt");
      form.set("response_format", "json");
      form.set("file", new Blob([new Uint8Array(p.audio)], { type: p.tipo }), p.nomeArquivo);
      let resposta: Response;
      try {
        resposta = await fetchImpl(`${this.o.baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.o.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(300_000),
        });
      } catch (error) {
        if (tentativa < this.o.maxRetries) {
          await sleep(1000 * 2 ** tentativa);
          continue;
        }
        throw new LlmError(`Falha de rede na OpenAI (${(error as Error).name})`, 0);
      }
      if (resposta.ok) {
        const r = z.object({ text: z.string() }).safeParse(await resposta.json().catch(() => null));
        if (!r.success) throw new LlmError("Transcrição fora do formato esperado", 200, "invalid_json");
        return { texto: r.data.text, modelo: p.modelo, duracaoMs: now() - inicio };
      }
      const corpo = (await resposta.json().catch(() => ({}))) as { error?: { code?: string; type?: string } };
      const semCredito = ["insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached"].includes(corpo.error?.code ?? "");
      if ((resposta.status === 429 || resposta.status >= 500) && !semCredito && tentativa < this.o.maxRetries) {
        const espera = Number(resposta.headers.get("retry-after"));
        await sleep((Number.isFinite(espera) && espera > 0 ? espera : 2 ** tentativa * 2) * 1000);
        continue;
      }
      throw new LlmError(`OpenAI respondeu ${resposta.status}${corpo.error?.code ? ` (${corpo.error.code})` : ""}`, resposta.status, corpo.error?.code ?? corpo.error?.type);
    }
  }

  async estruturado<T>(p: { modelo: string; sistema: string; entrada: string; nome: string; esquema: Record<string, unknown> }): Promise<RespostaLlm<T>> {
    const fetchImpl = this.o.fetch ?? fetch;
    const sleep = this.o.sleep ?? defaultSleep;
    const now = this.o.now ?? Date.now;
    const inicio = now();
    for (let tentativa = 0; ; tentativa += 1) {
      let resposta: Response;
      try {
        resposta = await fetchImpl(`${this.o.baseUrl}/responses`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.o.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: p.modelo,
            instructions: p.sistema,
            input: p.entrada,
            text: { format: { type: "json_schema", name: p.nome, schema: p.esquema, strict: true } },
            store: false,
          }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (error) {
        if (tentativa < this.o.maxRetries) {
          await sleep(1000 * 2 ** tentativa);
          continue;
        }
        throw new LlmError(`Falha de rede na OpenAI (${(error as Error).name})`, 0);
      }
      if (resposta.ok) {
        const r = respostaSchema.parse(await resposta.json());
        const conteudo = r.output.find((o) => o.type === "message")?.content ?? [];
        const recusa = conteudo.find((c) => c.type === "refusal");
        if (recusa) throw new LlmError("O modelo recusou a tarefa", 200, "refusal");
        const texto = conteudo.find((c) => c.type === "output_text")?.text;
        if (!texto || r.status === "incomplete") throw new LlmError(`Resposta incompleta (${r.incomplete_details?.reason ?? "sem texto"})`, 200, "incomplete");
        let dados: T;
        try {
          dados = JSON.parse(texto) as T;
        } catch {
          throw new LlmError("Resposta fora do formato pedido", 200, "invalid_json");
        }
        return { dados, modelo: r.model, tokensEntrada: r.usage?.input_tokens ?? 0, tokensSaida: r.usage?.output_tokens ?? 0, duracaoMs: now() - inicio };
      }
      const corpo = (await resposta.json().catch(() => ({}))) as { error?: { code?: string; type?: string } };
      // Sem crédito ou cota esgotada não passa com outra tentativa.
      const semCredito = ["insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached"].includes(corpo.error?.code ?? "");
      if ((resposta.status === 429 || resposta.status >= 500) && !semCredito && tentativa < this.o.maxRetries) {
        const espera = Number(resposta.headers.get("retry-after"));
        await sleep((Number.isFinite(espera) && espera > 0 ? espera : 2 ** tentativa * 2) * 1000);
        continue;
      }
      throw new LlmError(`OpenAI respondeu ${resposta.status}${corpo.error?.code ? ` (${corpo.error.code})` : ""}`, resposta.status, corpo.error?.code ?? corpo.error?.type);
    }
  }
}
