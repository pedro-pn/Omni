import { describe, expect, it } from "vitest";

import { EscritaDesligadaError, FiltroAppClient, FiltroAppError, type ModoEscrita } from "./client.ts";

const TOKEN = "t".repeat(64);

function projeto(code: string, extra: Record<string, unknown> = {}) {
  return {
    id: `proj-${code}`,
    code,
    name: "Cliente",
    isActive: true,
    location: "Itajaí",
    clientSegment: null,
    mobilizationDate: null,
    demobilizationDate: null,
    startDate: "2026-07-06T03:00:00.000Z",
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    clientName: "Cliente Ltda",
    clientCnpj: "12345678000190",
    commercialProposalCode: "4216",
    endDate: null,
    includesSaturday: false,
    includesSunday: false,
    workdayHours: "09:00",
    weekendWorkdayHours: "08:00",
    executedAtHeadquarters: false,
    campoNovoDoFiltroApp: "ignorado",
    ...extra,
  };
}

function colecao(items: unknown[], nextCursor: string | null) {
  return {
    items,
    page: { limit: 100, hasMore: nextCursor !== null, nextCursor, snapshotAt: "2026-10-28T12:00:00.000Z" },
    generatedAt: "2026-10-28T12:00:00.000Z",
    schemaVersion: "1.0",
    requestId: "req-1",
  };
}

const status = {
  projectId: "proj-5850",
  projectCode: "5850",
  workflowStarted: true,
  stage: "EXECUTION",
  workflowVersion: 4,
  plannedMobilizationDate: "2026-08-01",
  plannedExecutionStartDate: null,
  plannedExecutionEndDate: null,
  fieldCompletionDate: null,
  demobilizationDate: "2026-11-30",
  commercialReadiness: "READY",
  mobilizationReady: true,
  closureReady: false,
  openIssueCount: 2,
  criticalIssueCount: 0,
  progressPercent: 62.5,
  progressMethod: "SCOPE",
  closedAt: null,
  generatedAt: "2026-10-28T12:00:00.000Z",
  schemaVersion: "1.0",
  requestId: "req-2",
};

type Call = { url: string; auth: string | null; at: number };

function fakeServer(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  let clock = 0;
  const sleeps: number[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get("authorization"), at: clock });
    const next = responses.shift();
    if (!next) throw new Error("sem resposta simulada");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: next.headers });
  }) as typeof fetch;
  const client = new FiltroAppClient({
    baseUrl: "https://app.exemplo/api/integracoes/v1/",
    token: TOKEN,
    fetch: fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { client, calls, sleeps };
}

describe("FiltroAppClient", () => {
  it("pagina pelo cursor sem alterá-lo e manda o token só no cabeçalho", async () => {
    const { client, calls } = fakeServer([
      { status: 200, body: colecao([projeto("5850")], "cursor/assinado+1") },
      { status: 200, body: colecao([projeto("5861")], null) },
    ]);
    const itens = await client.listProjetos({ updatedSince: new Date("2026-10-27T00:00:00Z") });
    expect(itens.map((p) => p.code)).toEqual(["5850", "5861"]);
    expect(calls[0]!.url).toBe(
      "https://app.exemplo/api/integracoes/v1/projetos?limit=100&updatedSince=2026-10-27T00%3A00%3A00.000Z",
    );
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("cursor/assinado+1");
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}` && !c.url.includes(TOKEN))).toBe(true);
  });

  it("espaça as chamadas para caber no limite do token", async () => {
    const { client, calls } = fakeServer([
      { status: 200, body: colecao([projeto("5850")], "c2") },
      { status: 200, body: colecao([projeto("5861")], "c3") },
      { status: 200, body: colecao([projeto("5872")], null) },
    ]);
    await client.listProjetos();
    const intervals = calls.slice(1).map((c, i) => c.at - calls[i]!.at);
    expect(intervals.every((ms) => ms >= 1100)).toBe(true);
  });

  it("no 429 espera o Retry-After e tenta de novo", async () => {
    const { client, sleeps } = fakeServer([
      { status: 429, body: { code: "RATE_LIMITED" }, headers: { "retry-after": "7" } },
      { status: 200, body: status },
    ]);
    const s = await client.getStatusProjeto("proj-5850");
    expect(s?.stage).toBe("EXECUTION");
    expect(sleeps.some((ms) => ms >= 7000 && ms < 7500)).toBe(true);
  });

  it("status 404 vira null (projeto sem workflow)", async () => {
    const { client } = fakeServer([{ status: 404, body: { code: "NOT_FOUND", message: "Projeto não encontrado." } }]);
    expect(await client.getStatusProjeto("proj-x")).toBeNull();
  });

  it("erro de permissão sobe com código, sem vazar o token", async () => {
    const { client } = fakeServer([{ status: 403, body: { code: "SCOPE_DENIED", requestId: "r9" } }]);
    const error = await client.listProjetos().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FiltroAppError);
    expect((error as FiltroAppError).code).toBe("SCOPE_DENIED");
    expect((error as FiltroAppError).requestId).toBe("r9");
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it("recusa resposta fora do contrato em vez de gravar lixo", async () => {
    const { client } = fakeServer([{ status: 200, body: colecao([projeto("58A0")], null) }]);
    await expect(client.listProjetos()).rejects.toThrow();
  });

  it("lê responsáveis e status em coleção", async () => {
    const { client, calls } = fakeServer([
      {
        status: 200,
        body: colecao(
          [{ projectId: "proj-5850", projectCode: "5850", role: "LEADER", userId: "u1", collaboratorId: null, name: "Líder", email: "lider@filtrovali.com.br", updatedAt: "2026-10-28T10:00:00.000Z" }],
          null,
        ),
      },
      {
        status: 200,
        body: colecao(
          [{ ...status, generatedAt: undefined, schemaVersion: undefined, requestId: undefined, commercialExpectedMobilizationDate: "2026-07-20", commercialExpectedStartDate: null, commercialExpectedDurationDays: 65, actualMobilizationDate: "2026-08-01" }],
          null,
        ),
      },
    ]);
    const resp = await client.listResponsaveis();
    expect(resp[0]).toMatchObject({ role: "LEADER", email: "lider@filtrovali.com.br" });
    const st = await client.listStatus({ active: true });
    expect(st[0]).toMatchObject({ stage: "EXECUTION", commercialExpectedDurationDays: 65 });
    expect(calls[1]!.url).toContain("/efetivo/projetos/status?limit=100&active=true");
  });

  it("CNPJ fora do formato é recusado", async () => {
    const { client } = fakeServer([{ status: 200, body: colecao([projeto("5850", { clientCnpj: "12.345.678/0001-90" })], null) }]);
    await expect(client.listProjetos()).rejects.toThrow();
  });

  it("feed de eventos: devolve o próximo cursor e sinaliza cursor vencido", async () => {
    const evento = { id: "evt_1", type: "rdo.aprovado", occurredAt: "2026-10-28T12:00:00.000Z", projectId: "p", projectCode: "5850", resource: "rdo", resourceId: "r" };
    const { client, calls } = fakeServer([
      { status: 200, body: colecao([evento], "c2") },
      { status: 410, body: { code: "CURSOR_EXPIRED" } },
    ]);
    const pagina = await client.listEventos("c1");
    expect(pagina).toMatchObject({ nextCursor: "c2", hasMore: true });
    expect(new URL(calls[0]!.url).searchParams.get("cursor")).toBe("c1");
    const erro = await client.listEventos("velho").catch((e: unknown) => e);
    expect((erro as FiltroAppError).status).toBe(410);
    expect((erro as FiltroAppError).code).toBe("CURSOR_EXPIRED");
  });

  it("criar registro na Qualidade repete a mesma chave e o mesmo corpo após 5xx", async () => {
    const corpos: string[] = [];
    const chaves: string[] = [];
    let n = 0;
    const fetchImpl = (async (_: RequestInfo | URL, init?: RequestInit) => {
      corpos.push(String(init?.body));
      chaves.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      n += 1;
      return n === 1
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify({ id: "q1", number: "D-012/26", status: "EM_TRIAGEM", createdAt: "2026-10-28T12:00:00.000Z" }), { status: 201 });
    }) as typeof fetch;
    const client = new FiltroAppClient({ baseUrl: "https://x/api/integracoes/v1", token: TOKEN, fetch: fetchImpl, sleep: async () => {}, escrita: "real" });
    const r = await client.criarRegistroQualidade(
      {
        type: "DESVIO",
        projectCode: "5850",
        eventDate: "2026-10-28",
        description: "teste",
        impact: "MEDIO",
        actionOwnerEmail: "qualidade@filtrovali.com.br",
        externalRef: { system: "omni", url: "https://omni.filtrovali.com.br/", reference: "q-1" },
      },
      "8c1b5b0a-6c8e-4c3e-9a51-2f0f3f8a1d11",
    );
    expect(r.simulado ? null : r.resultado.number).toBe("D-012/26");
    expect(new Set(chaves)).toEqual(new Set(["8c1b5b0a-6c8e-4c3e-9a51-2f0f3f8a1d11"]));
    expect(corpos[0]).toBe(corpos[1]);
  });

  it("5xx tenta de novo com backoff", async () => {
    const { client } = fakeServer([
      { status: 502, body: {} },
      { status: 200, body: colecao([projeto("5850")], null) },
    ]);
    expect(await client.listProjetos()).toHaveLength(1);
  });
});

describe("modo de escrita no filtroAPP", () => {
  const corpo = {
    type: "DESVIO" as const,
    projectCode: "5850",
    eventDate: "2026-10-28",
    description: "teste",
    impact: "MEDIO" as const,
    actionOwnerEmail: "qualidade@filtrovali.com.br",
    externalRef: { system: "omni" as const, url: "https://omni.filtrovali.com.br/", reference: "q-1" },
  };
  const chave = "8c1b5b0a-6c8e-4c3e-9a51-2f0f3f8a1d11";

  function cliente(escrita: ModoEscrita | undefined, resposta: { body: unknown; headers?: Record<string, string>; status?: number }) {
    const pedidos: Array<Headers> = [];
    const fetchImpl = (async (_: RequestInfo | URL, init?: RequestInit) => {
      pedidos.push(new Headers(init?.headers));
      return new Response(JSON.stringify(resposta.body), { status: resposta.status ?? 200, headers: resposta.headers });
    }) as typeof fetch;
    return {
      client: new FiltroAppClient({ baseUrl: "https://x/api/integracoes/v1", token: TOKEN, fetch: fetchImpl, sleep: async () => {}, ...(escrita ? { escrita } : {}) }),
      pedidos,
    };
  }

  it("por padrão a escrita está desligada e nem chama o filtroAPP", async () => {
    const { client, pedidos } = cliente(undefined, { body: {} });
    await expect(client.criarRegistroQualidade(corpo, chave)).rejects.toBeInstanceOf(EscritaDesligadaError);
    expect(pedidos).toHaveLength(0);
  });

  it("simulada pede validate-only e aceita só com a confirmação do filtroAPP", async () => {
    const { client, pedidos } = cliente("simulada", {
      body: { simulated: true, wouldCreate: { type: "DESVIO", status: "EM_TRIAGEM" } },
      headers: { "Preference-Applied": "validate-only" },
    });
    const r = await client.criarRegistroQualidade(corpo, chave);
    expect(r.simulado).toBe(true);
    expect(pedidos[0]!.get("prefer")).toBe("validate-only");
    expect(pedidos[0]!.get("idempotency-key")).toBe(chave);
  });

  it("simulada sem confirmação é erro (pode ter gravado)", async () => {
    const { client } = cliente("simulada", {
      status: 201,
      body: { id: "q1", number: "D-012/26", status: "EM_TRIAGEM", createdAt: "2026-10-28T12:00:00.000Z" },
    });
    const erro = await client.criarRegistroQualidade(corpo, chave).catch((e: unknown) => e);
    expect((erro as FiltroAppError).code).toBe("SIMULATION_NOT_CONFIRMED");
  });

  it("real não aceita resposta simulada", async () => {
    const { client, pedidos } = cliente("real", { body: { simulated: true }, headers: { "Preference-Applied": "validate-only" } });
    const erro = await client.criarRegistroQualidade(corpo, chave).catch((e: unknown) => e);
    expect((erro as FiltroAppError).code).toBe("UNEXPECTED_SIMULATION");
    expect(pedidos[0]!.get("prefer")).toBeNull();
  });
});

describe("PDF dos relatórios e colaboradores (spec 038)", () => {
  it("baixa o PDF do relatório ou o documento de manutenção pelo caminho certo; 409 chega como está; id estranho é recusado", async () => {
    const pedidos: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      pedidos.push(`${url}|${new Headers(init?.headers).get("authorization") === `Bearer ${TOKEN}`}`);
      return url.includes("/pendente/") ? new Response(JSON.stringify({ code: "PDF_NOT_READY" }), { status: 409, headers: { "retry-after": "30" } }) : new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } });
    }) as typeof fetch;
    const client = new FiltroAppClient({ baseUrl: "https://x/api/integracoes/v1", token: TOKEN, fetch: fetchImpl, sleep: async () => {}, minIntervalMs: 0 });
    expect(await (await client.arquivo("relatorio", "rel_1")).text()).toBe("%PDF-1.7");
    await client.arquivo("manutencao", "anx-2");
    expect(pedidos).toEqual(["https://x/api/integracoes/v1/rdo/relatorios/rel_1/pdf|true", "https://x/api/integracoes/v1/manutencao/anexos/anx-2/download|true"]);
    await expect(client.arquivo("relatorio", "../segredo")).rejects.toThrow(/inválido/);
    const pendente = new FiltroAppClient({ baseUrl: "https://x/pendente/v1", token: TOKEN, fetch: fetchImpl, sleep: async () => {}, minIntervalMs: 0 });
    const r = await pendente.arquivo("relatorio", "rel_2");
    expect([r.status, r.headers.get("retry-after")]).toEqual([409, "30"]);
  });
});
