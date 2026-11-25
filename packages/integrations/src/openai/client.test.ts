import { describe, expect, it } from "vitest";

import { LlmError, OpenAiClient } from "./client.ts";

const CHAVE = "sk-teste-" + "x".repeat(30);
const ok = (texto: string, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { model: "gpt-teste", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: texto }] }], usage: { input_tokens: 100, output_tokens: 20 }, ...extra },
});

function cliente(respostas: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const chamadas: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    chamadas.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
    const r = respostas.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { c: new OpenAiClient({ apiKey: CHAVE, fetch: fetchImpl, sleep: async () => {} }), chamadas };
}
const pedido = { modelo: "gpt-teste", sistema: "Instruções", entrada: "Texto", nome: "analise", esquema: { type: "object" } };

describe("cliente da OpenAI", () => {
  it("pede saída estruturada estrita, sem guardar (store: false), e devolve dados e tokens", async () => {
    const { c, chamadas } = cliente([ok('{"pontos":[]}')]);
    const r = await c.estruturado<{ pontos: unknown[] }>(pedido);
    expect(r).toMatchObject({ dados: { pontos: [] }, modelo: "gpt-teste", tokensEntrada: 100, tokensSaida: 20 });
    expect(chamadas[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(chamadas[0]!.body).toMatchObject({ model: "gpt-teste", instructions: "Instruções", input: "Texto", store: false, text: { format: { type: "json_schema", strict: true, name: "analise" } } });
  });

  it("429 espera e tenta de novo; recusa, resposta incompleta e JSON inválido viram erro; a chave não vaza", async () => {
    const { c } = cliente([{ status: 429, body: {}, headers: { "retry-after": "1" } }, ok('{"ok":true}')]);
    expect((await c.estruturado(pedido)).dados).toEqual({ ok: true });
    for (const r of [
      { status: 200, body: { model: "m", output: [{ type: "message", content: [{ type: "refusal", refusal: "não" }] }] } },
      ok("{}", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
      ok("não é json"),
      { status: 401, body: { error: { code: "invalid_api_key" } } },
      { status: 429, body: { error: { code: "credit_balance_exhausted" } } },
    ]) {
      const { c: c2 } = cliente([r]);
      const erro = await c2.estruturado(pedido).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(LlmError);
      expect(String((erro as Error).message)).not.toContain(CHAVE);
    }
  });

  it("transcreve: multipart com modelo, português e o arquivo; 500 tenta de novo; a chave não vaza", async () => {
    const vistos: Array<{ url: string; form: FormData; auth: string | null }> = [];
    const respostas = [
      { status: 500, body: { error: { type: "server_error" } } },
      { status: 200, body: { text: "Bom dia, combinamos a entrega na sexta." } },
    ];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      vistos.push({ url: String(url), form: init?.body as FormData, auth: new Headers(init?.headers).get("authorization") });
      const r = respostas.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as typeof fetch;
    const c = new OpenAiClient({ apiKey: CHAVE, fetch: fetchImpl, sleep: async () => {} });
    const r = await c.transcrever({ modelo: "transcritor-teste", audio: new Uint8Array([1, 2, 3]), nomeArquivo: "ligacao.wav", tipo: "audio/wav" });
    expect(r.texto).toBe("Bom dia, combinamos a entrega na sexta.");
    expect(vistos).toHaveLength(2);
    expect(vistos[1]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(vistos[1]!.form.get("model")).toBe("transcritor-teste");
    expect(vistos[1]!.form.get("language")).toBe("pt");
    expect((vistos[1]!.form.get("file") as File).name).toBe("ligacao.wav");

    const semCredito = new OpenAiClient({
      apiKey: CHAVE,
      fetch: (async () => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 })) as typeof fetch,
      sleep: async () => {},
    });
    const erro = await semCredito.transcrever({ modelo: "m", audio: new Uint8Array([1]), nomeArquivo: "a.wav", tipo: "audio/wav" }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmError);
    expect(String((erro as Error).message)).not.toContain(CHAVE);
  });
});
