import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { novoFluxoPkce, PrismaClient, PrismaError, trocarCodigo, urlAutorizacao } from "./client.ts";

const READER = `prisma_omni_reader_${"a".repeat(64)}`;
const USER = `prisma_omni_user_${"b".repeat(64)}`;
const RETORNO = "http://localhost:3000/integracoes/prisma/retorno";

function respostas(lista: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const chamadas: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    chamadas.push({ url: String(input), init });
    const r = lista.shift();
    if (!r) throw new Error("sem resposta simulada");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { fetchImpl, chamadas };
}

describe("PKCE com o Prisma", () => {
  it("gera state e challenge no formato que o Prisma valida", () => {
    const f = novoFluxoPkce();
    expect(f.state).toMatch(/^[A-Za-z0-9_.~-]{16,200}$/);
    expect(f.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.challenge).toBe(createHash("sha256").update(f.verifier).digest("base64url"));
  });

  it("monta a URL de autorização só com os 8 parâmetros aceitos", () => {
    const url = new URL(urlAutorizacao({ environment: "sandbox", redirectUri: RETORNO, state: "s".repeat(43), challenge: "c".repeat(43) }));
    expect(url.origin + url.pathname).toBe("https://prismacrm.filtrovali.com.br/api/omni/oauth/authorize");
    expect([...url.searchParams.keys()].sort()).toEqual(
      ["client_id", "code_challenge", "code_challenge_method", "environment", "redirect_uri", "response_type", "scope", "state"],
    );
    expect(url.searchParams.get("scope")).toBe("contacts.write companies.write feedback.write missions.participants.write");
    expect(url.searchParams.get("redirect_uri")).toBe(RETORNO);
  });

  it("troca o código e calcula a validade", async () => {
    const { fetchImpl, chamadas } = respostas([
      { status: 200, body: { access_token: USER, token_type: "Bearer", expires_in: 3600, scope: "feedback.write contacts.write", environment: "sandbox" } },
    ]);
    const c = await trocarCodigo({ code: "abc", verifier: "v", redirectUri: RETORNO, fetch: fetchImpl, now: () => new Date("2026-10-28T12:00:00Z") });
    expect(c).toMatchObject({ accessToken: USER, scopes: ["feedback.write", "contacts.write"], environment: "sandbox" });
    expect(c.expiresAt.toISOString()).toBe("2026-10-28T13:00:00.000Z");
    expect(JSON.parse(String(chamadas[0]!.init!.body))).toEqual({
      client_id: "omni",
      grant_type: "authorization_code",
      code: "abc",
      code_verifier: "v",
      redirect_uri: RETORNO,
    });
  });

  it("troca recusada vira PrismaError sem dados sensíveis", async () => {
    const { fetchImpl } = respostas([{ status: 400, body: { error: "invalid_grant", requestId: "r1" } }]);
    const erro = await trocarCodigo({ code: "x", verifier: "v", redirectUri: RETORNO, fetch: fetchImpl }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(PrismaError);
    expect((erro as PrismaError).code).toBe("invalid_grant");
  });
});

describe("PrismaClient (leitura)", () => {
  const capabilities = {
    data: {
      environment: "sandbox",
      purpose: "reader",
      userId: null,
      actorId: null,
      scopes: [],
      resources: ["contacts"],
      limits: { requestsPerMinute: 120, rowsPerDay: 100000, pageSize: 100, batchSize: 25 },
    },
    revision: null,
    requestId: "r",
  };

  it("lê capabilities com o token só no cabeçalho", async () => {
    const { fetchImpl, chamadas } = respostas([{ status: 200, body: capabilities }]);
    const client = new PrismaClient({ token: READER, environment: "sandbox", fetch: fetchImpl, sleep: async () => {} });
    expect((await client.capabilities()).data.purpose).toBe("reader");
    expect(chamadas[0]!.url).toBe("https://prismacrm.filtrovali.com.br/api/omni/v1/sandbox/capabilities");
    expect(chamadas[0]!.url).not.toContain(READER);
  });

  it("pagina pelo cursor opaco até a página vazia", async () => {
    const { fetchImpl, chamadas } = respostas([
      { status: 200, body: { data: [{ id: "c1" }], nextCursor: { after: "c1" }, highWatermark: "42", requestId: "r" } },
      { status: 200, body: { data: [], nextCursor: null, highWatermark: "42", requestId: "r" } },
    ]);
    const client = new PrismaClient({ token: READER, environment: "sandbox", fetch: fetchImpl, sleep: async () => {} });
    const r = await client.listar("contacts", { updatedSince: new Date("2026-10-28T00:00:00Z") });
    expect(r).toEqual({ itens: [{ id: "c1" }], highWatermark: "42" });
    // O Prisma espera o cursor em JSON codificado em base64url.
    const cursor = new URL(chamadas[1]!.url).searchParams.get("cursor")!;
    expect(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))).toEqual({ after: "c1" });
    expect(new URL(chamadas[0]!.url).searchParams.get("updated_since")).toBe("2026-10-28T00:00:00.000Z");
  });

  it("feed de eventos: cursor decimal, devolve o próximo e o highWatermark", async () => {
    const evento = { id: 7, cursor: "7", type: "deals.folder_changed", resource: "deals", recordId: "d1", at: "2026-11-03T12:00:00Z", data: { id: "d1", sharepointFolders: [] } };
    const { fetchImpl, chamadas } = respostas([{ status: 200, body: { data: [evento], nextCursor: "7", highWatermark: "9", requestId: "r" } }]);
    const client = new PrismaClient({ token: READER, environment: "sandbox", fetch: fetchImpl, sleep: async () => {} });
    const r = await client.eventos("6");
    expect(r).toMatchObject({ nextCursor: "7", highWatermark: "9", itens: [{ type: "deals.folder_changed" }] });
    expect(new URL(chamadas[0]!.url).searchParams.get("cursor")).toBe("6");
  });

  it("no 429 espera o Retry-After", async () => {
    const esperas: number[] = [];
    const { fetchImpl } = respostas([
      { status: 429, body: { error: "rate_limit" }, headers: { "retry-after": "60" } },
      { status: 200, body: capabilities },
    ]);
    const client = new PrismaClient({ token: READER, environment: "sandbox", fetch: fetchImpl, sleep: async (ms) => void esperas.push(ms) });
    await client.capabilities();
    expect(esperas.some((ms) => ms >= 60_000)).toBe(true);
  });

  it("recusa token em formato inesperado", () => {
    expect(() => new PrismaClient({ token: "qualquer", environment: "sandbox" })).toThrow(/inválido/);
  });
});

describe("Fase 6 do Prisma (contrato 1.67.0)", () => {
  const CHAVE = "11111111-2222-4333-8444-555555555555";
  it("lookup por e-mail ou telefone, com o limite de feedback", async () => {
    const { fetchImpl, chamadas } = respostas([
      { status: 200, body: { data: [{ contact: { id: "c1", name: "João" }, company: { id: "e1", name: "Porto Norte" }, companies: [], openDeals: [{ id: "d1", title: "Flushing" }], feedback: [] }], ambiguous: false, requestId: "r" } },
      { status: 200, body: { data: [], ambiguous: false, requestId: "r" } },
    ]);
    const p = new PrismaClient({ token: READER, environment: "sandbox", fetch: fetchImpl, sleep: async () => {} });
    const r = await p.lookup({ email: "joao@portonorte.com.br" }, 3);
    expect(r.itens[0]!.company?.name).toBe("Porto Norte");
    await p.lookup({ phone: "+5547999990000" });
    expect(chamadas.map((c) => c.url.replace("https://prismacrm.filtrovali.com.br/api/omni/v1/sandbox", ""))).toEqual([
      "/contacts/lookup?email=joao%40portonorte.com.br&feedbackLimit=3",
      "/contacts/lookup?phone=%2B5547999990000&feedbackLimit=5",
    ]);
  });

  it("escrita: POST com Idempotency-Key e If-Match; devolve a revisão nova; erro {error:{code}}; 5xx não repete", async () => {
    const { fetchImpl, chamadas } = respostas([
      { status: 200, body: { data: { id: "c9", created: true }, revision: 42, requestId: "r" } },
      { status: 409, body: { error: { code: "company_conflict" }, requestId: "r2" } },
      { status: 503, body: { error: { code: "temporarily_unavailable" } } },
    ]);
    const p = new PrismaClient({ token: USER, environment: "sandbox", fetch: fetchImpl, sleep: async () => {} });
    const r = await p.upsertContato({ name: "João", email: "joao@portonorte.com.br", title: "Coordenador" }, { chave: CHAVE, revisao: 41 });
    expect(r).toEqual({ dados: { id: "c9", created: true }, revisao: 42 });
    const h = new Headers(chamadas[0]!.init?.headers);
    expect([chamadas[0]!.init?.method, h.get("idempotency-key"), h.get("if-match"), h.get("content-type")]).toEqual(["POST", CHAVE, '"41"', "application/json"]);
    const erro = await p.vincularParticipante("m1", { contactId: "c9", companyId: "e2" }, { chave: CHAVE, revisao: 42 }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(PrismaError);
    expect((erro as PrismaError).code).toBe("company_conflict");
    expect(JSON.parse(String(chamadas[1]!.init?.body))).toEqual({ contactId: "c9", companyId: "e2", role: "customer" });
    await expect(p.registrarFeedback({ text: "x", kind: "feedback", source: "call", occurredAt: "2026-11-10T10:00:00-03:00", sourceUrl: "https://omni.filtrovali.com.br/" }, { chave: CHAVE, revisao: 42 })).rejects.toThrow(/503/);
    expect(chamadas).toHaveLength(3);
    await expect(p.upsertContato({ name: "x" }, { chave: "nao-uuid", revisao: 1 })).rejects.toThrow(/idempotência/);
  });
});
