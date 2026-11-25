import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GraphClient, GraphError } from "./client.ts";

/** Respostas sintéticas do Graph (nenhuma chamada real). */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const THUMB = "ab".repeat(32);
const G = "https://graph.microsoft.com/v1.0";

type Resp = { status: number; body?: unknown; headers?: Record<string, string> };
function cliente(rotas: Array<[RegExp, Resp | ((url: string) => Resp)]>) {
  const chamadas: Array<{ url: string; auth: string | null; body?: string; redirect?: string; prefer?: string | null; method?: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    chamadas.push({ url, auth: headers.get("authorization"), body: init?.body ? String(init.body) : undefined, redirect: init?.redirect, prefer: headers.get("prefer"), method: init?.method });
    if (url.startsWith("https://login.microsoftonline.com/")) {
      return new Response(JSON.stringify({ access_token: "tok-sintetico", expires_in: 3600 }), { status: 200 });
    }
    const rota = rotas.find(([re]) => re.test(url));
    if (!rota) return new Response(JSON.stringify({ error: { code: "itemNotFound" } }), { status: 404 });
    const r = typeof rota[1] === "function" ? rota[1](url) : rota[1];
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const g = new GraphClient({ tenantId: "tenant-x", clientId: "cliente-x", privateKeyPem: PEM, thumbprintSha256: THUMB, fetch: fetchImpl, sleep: async () => {} });
  return { g, chamadas };
}
const item = (id: string, pai: string | null, extra: Record<string, unknown> = {}) => ({ id, name: `nome-${id}`, parentReference: pai ? { id: pai, driveId: "d1" } : { driveId: "d1" }, ...extra });

describe("cliente do Graph", () => {
  it("lido/não lido: PATCH só com isRead; id estranho recusado antes da chamada; 403 chega como erro", async () => {
    const { g, chamadas } = cliente([[/\/users\/ana%40x\.com\/messages\/AAMk[^/]+$/, { status: 200, body: { id: "AAMkAAA111" } }]]);
    await g.marcarComoLido("ana@x.com", "AAMkAAA111", false);
    const c = chamadas.at(-1)!;
    expect([c.method, c.url, c.body]).toEqual(["PATCH", `${G}/users/ana%40x.com/messages/AAMkAAA111`, JSON.stringify({ isRead: false })]);
    await expect(g.marcarComoLido("ana@x.com", "../outra", true)).rejects.toThrow(/inválido/);
    const negado = cliente([[/messages/, { status: 403, body: { error: { code: "ErrorAccessDenied" } } }]]);
    await expect(negado.g.marcarComoLido("ana@x.com", "AAMkAAA111", true)).rejects.toMatchObject({ status: 403 });
  });

  it("avisos do Graph: assina a Entrada com o segredo, renova e apaga (404 conta como apagada); só HTTPS", async () => {
    const sub = "0f0e0d0c-0b0a-4000-8000-000000000001";
    const { g, chamadas } = cliente([
      [/\/subscriptions$/, { status: 201, body: { id: sub, expirationDateTime: "2026-11-27T10:00:00Z" } }],
      [new RegExp(`/subscriptions/${sub}$`), (u) => ({ status: 200, body: { id: sub, expirationDateTime: "2026-11-28T10:00:00Z" }, headers: {} })],
    ]);
    const nova = await g.assinarEntrada("ana@x.com", "https://omni.exemplo/api/graph/avisos", "segredo", new Date("2026-11-27T10:00:00Z"));
    expect(nova).toEqual({ id: sub, expira: new Date("2026-11-27T10:00:00Z") });
    expect(JSON.parse(chamadas.at(-1)!.body!)).toMatchObject({ changeType: "created", resource: "users/ana%40x.com/mailFolders('inbox')/messages", clientState: "segredo" });
    expect(await g.renovarAssinatura(sub, new Date("2026-11-28T10:00:00Z"))).toEqual(new Date("2026-11-28T10:00:00Z"));
    expect(chamadas.at(-1)!.method).toBe("PATCH");
    await g.apagarAssinatura("0f0e0d0c-0b0a-4000-8000-000000000999"); // 404: já não existe
    expect(chamadas.at(-1)!.method).toBe("DELETE");
    await expect(g.assinarEntrada("ana@x.com", "http://inseguro", "s", new Date())).rejects.toThrow(/HTTPS/);
    await expect(g.renovarAssinatura("nao-e-uuid", new Date())).rejects.toThrow(/inválida/);
  });

  it("token pelo certificado: asserção RS256 com x5t#S256, verificável pela chave pública; reaproveita o token", async () => {
    const { g, chamadas } = cliente([[/\/items\/raiz\/children/, { status: 200, body: { value: [] } }]]);
    await g.listarFilhos("d1", "raiz");
    await g.listarFilhos("d1", "raiz");
    const tokens = chamadas.filter((c) => c.url.includes("login.microsoftonline.com"));
    expect(tokens).toHaveLength(1);
    const form = new URLSearchParams(tokens[0]!.body);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("https://graph.microsoft.com/.default");
    const [h, p, s] = form.get("client_assertion")!.split(".");
    const header = JSON.parse(Buffer.from(h!, "base64url").toString());
    expect(header).toMatchObject({ alg: "RS256", "x5t#S256": Buffer.from(THUMB, "hex").toString("base64url") });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toMatchObject({ iss: "cliente-x", sub: "cliente-x", aud: "https://login.microsoftonline.com/tenant-x/oauth2/v2.0/token" });
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    expect(chamadas.find((c) => c.url.startsWith(G))!.auth).toBe("Bearer tok-sintetico");
  });

  it("lista todas as páginas, pastas primeiro; recusa próxima página fora do Graph", async () => {
    const { g } = cliente([
      [/children\?\$select/, { status: 200, body: { value: [item("b", "raiz", { file: { mimeType: "application/pdf" }, size: 10 })], "@odata.nextLink": `${G}/drives/d1/items/raiz/children?$skiptoken=2` } }],
      [/skiptoken=2/, { status: 200, body: { value: [item("a", "raiz", { folder: { childCount: 3 } })] } }],
    ]);
    const itens = await g.listarFilhos("d1", "raiz");
    expect(itens.map((i) => [i.id, i.tipo, i.filhos ?? i.mime])).toEqual([
      ["a", "pasta", 3],
      ["b", "arquivo", "application/pdf"],
    ]);
    const { g: g2 } = cliente([[/children/, { status: 200, body: { value: [], "@odata.nextLink": "https://outro.example/roubo" } }]]);
    await expect(g2.listarFilhos("d1", "raiz")).rejects.toThrow(/inesperado/);
  });

  it("item dentro da pasta autorizada: devolve o caminho; fora dela: null", async () => {
    const { g } = cliente([
      [/items\/arq\?/, { status: 200, body: item("arq", "sub") }],
      [/items\/sub\?/, { status: 200, body: item("sub", "raiz") }],
      [/items\/raiz\?/, { status: 200, body: item("raiz", "topo") }],
      [/items\/topo\?/, { status: 200, body: item("topo", null) }],
      [/items\/fora\?/, { status: 200, body: item("fora", "topo") }],
    ]);
    expect((await g.caminhoDentro("d1", "raiz", "arq"))!.map((x) => x.id)).toEqual(["raiz", "sub", "arq"]);
    expect(await g.caminhoDentro("d1", "raiz", "fora")).toBeNull();
    expect(await g.caminhoDentro("d1", "raiz", "topo")).toBeNull();
  });

  it("download: segue o redirecionamento sem mandar o token para fora do Graph", async () => {
    const { g, chamadas } = cliente([
      [/items\/arq\/content/, { status: 302, headers: { location: "https://tenant.sharepoint.com/download?tempauth=x" } }],
      [/sharepoint\.com\/download/, { status: 200, body: "conteudo" }],
    ]);
    const r = await g.baixar("d1", "arq");
    expect(r.status).toBe(200);
    expect(chamadas.find((c) => c.url.includes("/content"))!.redirect).toBe("manual");
    expect(chamadas.find((c) => c.url.includes("sharepoint.com"))!.auth).toBeNull();
  });

  it("429 espera e tenta de novo; 404 e 403 viram GraphError com o status; id estranho é recusado", async () => {
    let n = 0;
    const { g } = cliente([
      [/items\/lento\?/, () => (n++ === 0 ? { status: 429, headers: { "retry-after": "1" } } : { status: 200, body: item("lento", "raiz") })],
      [/items\/proibido\?/, { status: 403, body: { error: { code: "accessDenied" } } }],
    ]);
    expect((await g.item("d1", "lento")).id).toBe("lento");
    await expect(g.item("d1", "sumiu")).rejects.toMatchObject({ status: 404, code: "itemNotFound" });
    await expect(g.item("d1", "proibido")).rejects.toMatchObject({ status: 403 });
    await expect(g.item("d1", "../../users")).rejects.toBeInstanceOf(GraphError);
  });

  it("e-mails: delta com filtro por data e texto puro, removidas, continuação e deltaLink", async () => {
    const msg = (id: string) => ({ id, internetMessageId: `<${id}@x>`, subject: `Assunto ${id}`, body: { contentType: "text", content: "corpo" } });
    const { g, chamadas } = cliente([
      [/messages\/delta\?\$select/, { status: 200, body: { value: [msg("m1"), { id: "m0", "@removed": { reason: "deleted" } }], "@odata.nextLink": `${G}/users/a%40b.com/mailFolders/inbox/messages/delta?$skiptoken=2` } }],
      [/skiptoken=2/, { status: 200, body: { value: [msg("m2")], "@odata.nextLink": `${G}/users/a%40b.com/mailFolders/inbox/messages/delta?$skiptoken=3` } }],
      [/skiptoken=3/, { status: 200, body: { value: [], "@odata.deltaLink": `${G}/users/a%40b.com/mailFolders/inbox/messages/delta?$deltatoken=d1` } }],
    ]);
    const desde = new Date("2026-08-01T00:00:00Z");
    const parcial = await g.mensagensDelta("a@b.com", "inbox", null, { desde, maxPaginas: 2 });
    expect(parcial).toMatchObject({ removidas: ["m0"], deltaLink: null });
    expect(parcial.mensagens.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(parcial.continuar).toContain("skiptoken=3");
    const primeira = chamadas.find((c) => c.url.includes("/delta?$select"))!;
    expect(decodeURIComponent(primeira.url)).toContain("receivedDateTime ge 2026-08-01T00:00:00.000Z");
    expect(primeira.prefer).toContain('outlook.body-content-type="text"');
    const fim = await g.mensagensDelta("a@b.com", "inbox", parcial.continuar, { desde });
    expect(fim).toMatchObject({ mensagens: [], continuar: null, deltaLink: expect.stringContaining("deltatoken=d1") });
    await expect(g.mensagensDelta("nao-e-email", "inbox", null, { desde })).rejects.toBeInstanceOf(GraphError);
  });

  it("e-mail para ler: corpo em texto e anexos", async () => {
    const { g } = cliente([
      [/attachments\/ANEXO0000001\/\$value/, { status: 200, body: "pdf" }],
      [
        /messages\/AAMkID123456\/attachments\?/,
        {
          status: 200,
          body: {
            value: [
              { id: "ANEXO0000001", name: "proposta.pdf", size: 1000, isInline: false, contentType: "application/pdf", "@odata.type": "#microsoft.graph.fileAttachment" },
              { id: "ANEXO0000002", name: "Encaminhado", size: 50, isInline: false, "@odata.type": "#microsoft.graph.itemAttachment" },
            ],
          },
        },
      ],
      [/messages\/AAMkID123456\?/, { status: 200, body: { id: "AAMkID123456", subject: "Oi", hasAttachments: true, body: { contentType: "text", content: "Olá" } } }],
    ]);
    const m = await g.mensagem("a@b.com", "AAMkID123456");
    expect(m).toMatchObject({
      subject: "Oi",
      body: { content: "Olá" },
      anexos: [
        { id: "ANEXO0000001", nome: "proposta.pdf", tamanho: 1000, inline: false, arquivo: true, mime: "application/pdf" },
        { id: "ANEXO0000002", arquivo: false },
      ],
    });
    expect((await g.anexo("a@b.com", "AAMkID123456", "ANEXO0000001")).status).toBe(200);
    await expect(g.anexo("a@b.com", "AAMkID123456", "../x")).rejects.toBeInstanceOf(GraphError);
  });

  it("envio: sendMail e reply em texto puro; 429 espera; 5xx não repete; destinatário inválido recusado", async () => {
    let tentativas = 0;
    const { g, chamadas } = cliente([
      [/\/sendMail$/, () => (tentativas++ === 0 ? { status: 429, headers: { "retry-after": "1" } } : { status: 202 })],
      [/\/reply$/, { status: 503, body: { error: { code: "ServiceUnavailable" } } }],
    ]);
    await g.enviarEmail("eu@filtrovali.com.br", { assunto: "5851 - teste", texto: "Olá", para: ["a@b.com"], cc: [], cco: ["c@d.com"] });
    const envio = chamadas.filter((c) => c.url.endsWith("/sendMail"));
    expect(envio).toHaveLength(2);
    expect(JSON.parse(envio[1]!.body!)).toMatchObject({
      message: { subject: "5851 - teste", body: { contentType: "Text", content: "Olá" }, toRecipients: [{ emailAddress: { address: "a@b.com" } }], bccRecipients: [{ emailAddress: { address: "c@d.com" } }] },
      saveToSentItems: true,
    });
    await expect(g.responderEmail("eu@filtrovali.com.br", "AAMkID123456", { texto: "ok", para: ["a@b.com"], cc: [], cco: [] })).rejects.toMatchObject({ status: 503 });
    expect(chamadas.filter((c) => c.url.endsWith("/reply"))).toHaveLength(1);
    await expect(g.enviarEmail("eu@filtrovali.com.br", { assunto: "x", texto: "y", para: ["nao-e-email"], cc: [], cco: [] })).rejects.toBeInstanceOf(GraphError);
  });

  it("anexos no envio e na resposta: arquivo do Graph com o conteúdo em base64; sem anexo, sem a propriedade", async () => {
    const { g, chamadas } = cliente([
      [/\/sendMail$/, { status: 202 }],
      [/\/reply$/, { status: 202 }],
    ]);
    const anexos = [{ nome: "proposta.pdf", tipo: "application/pdf", conteudo: Buffer.from("%PDF") }];
    await g.enviarEmail("eu@filtrovali.com.br", { assunto: "x", texto: "y", para: ["a@b.com"], cc: [], cco: [], anexos });
    await g.responderEmail("eu@filtrovali.com.br", "AAMkID123456", { texto: "ok", para: ["a@b.com"], cc: [], cco: [], anexos });
    await g.enviarEmail("eu@filtrovali.com.br", { assunto: "x", texto: "y", para: ["a@b.com"], cc: [], cco: [] });
    const anexo = { "@odata.type": "#microsoft.graph.fileAttachment", name: "proposta.pdf", contentType: "application/pdf", contentBytes: Buffer.from("%PDF").toString("base64") };
    const [envio, semAnexo] = chamadas.filter((c) => c.url.endsWith("/sendMail")).map((c) => JSON.parse(c.body!));
    expect(envio.message.attachments).toEqual([anexo]);
    expect(JSON.parse(chamadas.find((c) => c.url.endsWith("/reply"))!.body!).message.attachments).toEqual([anexo]);
    expect(semAnexo.message).not.toHaveProperty("attachments");
  });

  it("pessoas do app Omni: atribuições paginadas e sem repetição, membros de grupos com ConsistencyLevel, convidados e contas desligadas marcados", async () => {
    const APP = "11111111-2222-4333-8444-555555555555";
    const U1 = "aaaaaaaa-0000-4000-8000-000000000001", U2 = "aaaaaaaa-0000-4000-8000-000000000002", G1 = "bbbbbbbb-0000-4000-8000-000000000001";
    const { g, chamadas } = cliente([
      [/appRoleAssignedTo\?.*skiptoken=2/, { status: 200, body: { value: [{ principalId: U1, principalType: "User" }, { principalId: "cccccccc-0000-4000-8000-000000000001", principalType: "ServicePrincipal" }] } }],
      [/servicePrincipals\(appId='11111111-2222-4333-8444-555555555555'\)\/appRoleAssignedTo/, { status: 200, body: { value: [{ principalId: U1, principalType: "User" }, { principalId: G1, principalType: "Group" }], "@odata.nextLink": `${G}/servicePrincipals(appId='${APP}')/appRoleAssignedTo?$skiptoken=2` } }],
      [/groups\/bbbbbbbb-0000-4000-8000-000000000001\/transitiveMembers\/microsoft\.graph\.user/, { status: 200, body: { value: [
        { id: U2, displayName: " Bia ", mail: null, userPrincipalName: "Bia@Filtrovali.com.br", accountEnabled: true, userType: "Member" },
        { id: "aaaaaaaa-0000-4000-8000-000000000003", displayName: "Fora", mail: "fora@cliente.com", userPrincipalName: "fora_cliente.com#EXT#@filtrovali.onmicrosoft.com", accountEnabled: true, userType: "Guest" },
        { id: "aaaaaaaa-0000-4000-8000-000000000004", displayName: "Saiu", mail: "saiu@filtrovali.com.br", accountEnabled: false },
      ] } }],
      [/users\/aaaaaaaa-0000-4000-8000-000000000001/, { status: 200, body: { id: U1, displayName: "Ana", mail: "ana@filtrovali.com.br", accountEnabled: true } }],
    ]);
    expect(await g.atribuidosAoApp(APP)).toEqual([{ tipo: "usuario", id: U1 }, { tipo: "grupo", id: G1 }]);
    expect(await g.pessoasDoGrupo(G1)).toEqual([
      { id: U2, nome: "Bia", email: "bia@filtrovali.com.br", ativa: true, convidada: false },
      { id: "aaaaaaaa-0000-4000-8000-000000000003", nome: "Fora", email: "fora@cliente.com", ativa: true, convidada: true },
      { id: "aaaaaaaa-0000-4000-8000-000000000004", nome: "Saiu", email: "saiu@filtrovali.com.br", ativa: false, convidada: false },
    ]);
    expect(await g.usuarioEntra(U1)).toEqual({ id: U1, nome: "Ana", email: "ana@filtrovali.com.br", ativa: true, convidada: false });
    expect(await g.usuarioEntra("aaaaaaaa-0000-4000-8000-00000000000f")).toBeNull();
    await expect(g.atribuidosAoApp("nao-e-uuid")).rejects.toThrow(GraphError);
    await expect(g.pessoasDoGrupo("../users")).rejects.toThrow(GraphError);
    expect(chamadas.filter((c) => c.url.includes("appRoleAssignedTo"))).toHaveLength(2);
  });

  it("gravações no SharePoint: upload em partes pela sessão (sem o token), trecho com Range e exclusão definitiva", async () => {
    const UP = "https://tenant.sharepoint.com/sites/OmniAnexos/_api/upload?guid=1";
    const puts: Array<{ range: string | null; tamanho: number; auth: string | null }> = [];
    const total = 12 * 1024 * 1024;
    const base = cliente([
      [/root:\/Gravacoes\/2026\/11\/abc\.m4a:\/createUploadSession/, { status: 200, body: { uploadUrl: UP } }],
      [/items\/IT1\/permanentDelete/, { status: 204 }],
      [/items\/SUMIU\/permanentDelete/, { status: 404, body: { error: { code: "itemNotFound" } } }],
      [/items\/IT1\/content/, { status: 302, headers: { location: "https://tenant.sharepoint.com/download?x=1" } }],
    ]);
    const fetchOriginal = (base.g as unknown as { fetchImpl: typeof fetch }).fetchImpl;
    (base.g as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url === UP) {
        puts.push({ range: headers.get("content-range"), tamanho: (init?.body as Uint8Array).byteLength, auth: headers.get("authorization") });
        const fim = Number(headers.get("content-range")!.split("-")[1]!.split("/")[0]);
        return fim + 1 === total ? new Response(JSON.stringify({ id: "IT1", size: total }), { status: 201 }) : new Response(null, { status: 202 });
      }
      if (url.startsWith("https://tenant.sharepoint.com/download")) return new Response("abc", { status: 206, headers: { "Content-Range": headers.get("range") ?? "" } });
      return fetchOriginal(input, init);
    }) as typeof fetch;
    expect(await base.g.enviarArquivo("d1", "Gravacoes/2026/11/abc.m4a", new Uint8Array(total))).toEqual({ id: "IT1", tamanho: total });
    expect(puts).toEqual([
      { range: `bytes 0-${10485760 - 1}/${total}`, tamanho: 10485760, auth: null },
      { range: `bytes 10485760-${total - 1}/${total}`, tamanho: total - 10485760, auth: null },
    ]);
    const trecho = await base.g.baixar("d1", "IT1", { range: "bytes=0-2" });
    expect([trecho.status, trecho.headers.get("content-range")]).toEqual([206, "bytes=0-2"]);
    await base.g.apagarDefinitivo("d1", "IT1");
    await base.g.apagarDefinitivo("d1", "SUMIU"); // já apagado
    // O Graph recusa o permanentDelete com corpo (até "{}"): vai sem corpo nem Content-Type.
    const apagar = base.chamadas.find((c) => c.url.includes("/items/IT1/permanentDelete"));
    expect(apagar?.body).toBeUndefined();
    await expect(base.g.enviarArquivo("d1", "Gravacoes/Maria Silva 47999/x.m4a", new Uint8Array(1))).rejects.toThrow(GraphError);
    await expect(base.g.enviarArquivo("d1", "../x.m4a", new Uint8Array(1))).rejects.toThrow(GraphError);
  });

  it("caixa da pessoa: pastas do sistema primeiro (sem as internas), mensagens de 50 em 50 e pesquisa", async () => {
    const CX = "ana@filtrovali.com.br";
    const { g, chamadas } = cliente([
      [/mailFolders\/inbox\?/, { status: 200, body: { id: "AAMkPastaIN01" } }],
      [/mailFolders\/sentitems\?/, { status: 200, body: { id: "AAMkPastaSE01" } }],
      [/mailFolders\/drafts\?/, { status: 200, body: { id: "AAMkPastaDR01" } }],
      [/mailFolders\/archive\?/, { status: 404, body: { error: { code: "ErrorItemNotFound" } } }],
      [/mailFolders\/deleteditems\?/, { status: 200, body: { id: "AAMkPastaDE01" } }],
      [/mailFolders\/junkemail\?/, { status: 200, body: { id: "AAMkPastaJU01" } }],
      [/mailFolders\/AAMkPastaIN01\/messages\?.*search/, { status: 200, body: { value: [{ id: "M9", subject: "Proposta 4711", isRead: true }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/x" } }],
      [/mailFolders\/AAMkPastaIN01\/messages\?/, (url) => ({ status: 200, body: { value: [{ id: url.includes("skip=50") ? "M51" : "M1", subject: null, from: { emailAddress: { name: "Cliente", address: "Compras@Cliente.com.br" } }, isRead: false, importance: "high", hasAttachments: true, bodyPreview: "Olá" }], ...(url.includes("skip=50") ? {} : { "@odata.nextLink": "https://graph.microsoft.com/v1.0/y" }) } })],
      [/mailFolders\?\$top=100/, { status: 200, body: { value: [{ id: "AAMkPastaXX01", displayName: "Obras" }, { id: "AAMkPastaDE01", displayName: "Itens Excluídos", unreadItemCount: 0 }, { id: "AAMkPastaSY01", displayName: "Problemas de Sincronização" }, { id: "AAMkPastaIN01", displayName: "Caixa de Entrada", unreadItemCount: 3, totalItemCount: 90 }, { id: "AAMkPastaSE01", displayName: "Itens Enviados" }] } }],
    ]);
    const pastas = await g.pastasDeEmail(CX);
    expect(pastas.map((p) => [p.nome, p.sistema, p.naoLidas])).toEqual([
      ["Caixa de Entrada", "inbox", 3],
      ["Itens Enviados", "sentitems", 0],
      ["Itens Excluídos", "deleteditems", 0],
      ["Obras", null, 0],
    ]);
    const p1 = await g.mensagensDaPasta(CX, "AAMkPastaIN01");
    expect(p1).toEqual({
      mensagens: [{ id: "M1", assunto: "(sem assunto)", de: { nome: "Cliente", endereco: "compras@cliente.com.br" }, para: [], em: null, previa: "Olá", anexos: true, lida: false, importante: true, rascunho: false }],
      haMais: true,
    });
    expect((await g.mensagensDaPasta(CX, "AAMkPastaIN01", { inicio: 50 })).haMais).toBe(false);
    const b = await g.mensagensDaPasta(CX, "AAMkPastaIN01", { busca: 'proposta "4711"' });
    expect(b).toMatchObject({ mensagens: [{ id: "M9", assunto: "Proposta 4711" }], haMais: false });
    const buscaUrl = chamadas.find((c) => c.url.includes("search"))!.url;
    expect(decodeURIComponent(buscaUrl)).toContain('$search="proposta  4711"');
    await expect(g.mensagensDaPasta(CX, "../users/outro")).rejects.toThrow(GraphError);
  });
});

