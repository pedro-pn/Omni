import { describe, expect, it } from "vitest";

import { CABECALHO_WEBHOOK, EvolutionClient, EVENTOS_WEBHOOK, lerEventoWebhook, lerMensagemEvolution, PonteDeAcoes, WhatsAppError } from "./index.ts";

const CHAVE = "k".repeat(64);
const SEGREDO = "s".repeat(64);
const WEBHOOK = { url: "http://web:3000/api/whatsapp/webhook", segredo: SEGREDO };

function evolution(respostas: Record<string, Array<{ status: number; body: unknown }>>) {
  const chamadas: Array<{ metodo: string; rota: string; body: unknown; chave: string | null }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const rota = String(url).replace("http://evolution:8080/", "");
    chamadas.push({ metodo: init?.method ?? "GET", rota, body: init?.body ? JSON.parse(String(init.body)) : null, chave: new Headers(init?.headers).get("apikey") });
    const r = respostas[`${init?.method} ${rota}`]?.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { c: new EvolutionClient({ url: "http://evolution:8080/", chave: CHAVE, fetch: fetchImpl }), chamadas };
}

const webhookGravado = { enabled: true, url: WEBHOOK.url, events: [...EVENTOS_WEBHOOK], webhookBase64: false, headers: { [CABECALHO_WEBHOOK]: SEGREDO } };

describe("Evolution", () => {
  it("cria o número com configurações seguras e confere o webhook gravado", async () => {
    const { c, chamadas } = evolution({
      "POST instance/create": [{ status: 201, body: {} }],
      "POST settings/set/omni-abc123": [{ status: 201, body: {} }],
      "POST webhook/set/omni-abc123": [{ status: 201, body: {} }],
      "GET webhook/find/omni-abc123": [{ status: 200, body: webhookGravado }],
    });
    await c.criarNumero("omni-abc123", WEBHOOK);
    expect(chamadas.map((x) => `${x.metodo} ${x.rota}`)).toEqual(["POST instance/create", "POST settings/set/omni-abc123", "POST webhook/set/omni-abc123", "GET webhook/find/omni-abc123"]);
    expect(chamadas.every((x) => x.chave === CHAVE)).toBe(true);
    expect(chamadas[0]!.body).toMatchObject({ instanceName: "omni-abc123", integration: "WHATSAPP-BAILEYS", alwaysOnline: false, readMessages: false, syncFullHistory: true });
    expect(chamadas[2]!.body).toEqual({
      webhook: { enabled: true, url: WEBHOOK.url, headers: { [CABECALHO_WEBHOOK]: SEGREDO }, byEvents: false, base64: false, events: [...EVENTOS_WEBHOOK] },
    });
  });

  it("webhook gravado diferente do pedido é erro; nome de instância fora do padrão é recusado antes de chamar", async () => {
    const { c } = evolution({
      "POST settings/set/omni-abc123": [{ status: 201, body: {} }],
      "POST webhook/set/omni-abc123": [{ status: 201, body: {} }],
      "GET webhook/find/omni-abc123": [{ status: 200, body: { ...webhookGravado, url: "https://outro.invalid/hook" } }],
    });
    await expect(c.configurarNumero("omni-abc123", WEBHOOK)).rejects.toMatchObject({ code: "webhook_divergente" });
    await expect(c.estado("../instance/delete")).rejects.toBeInstanceOf(WhatsAppError);
    await expect(c.qrCode("prisma-vendas")).rejects.toMatchObject({ code: "instancia_invalida" });
  });

  it("QR em PNG enquanto pareia; estado e telefone pelo fetchInstances; a chave não aparece nos erros", async () => {
    const { c } = evolution({
      "GET instance/connect/omni-abc123": [{ status: 200, body: { pairingCode: null, code: "2@x", base64: "data:image/png;base64,iVBOR", count: 1 } }],
      "GET instance/fetchInstances": [
        { status: 200, body: [{ name: "omni-outro1", connectionStatus: "open" }, { name: "omni-abc123", connectionStatus: "open", ownerJid: "5547999990000@s.whatsapp.net", profileName: "Operação" }] },
        { status: 401, body: { error: "Unauthorized" } },
      ],
    });
    expect(await c.qrCode("omni-abc123")).toEqual({ imagem: "data:image/png;base64,iVBOR", codigoPareamento: null, estado: "conectando" });
    expect(await c.estado("omni-abc123")).toEqual({ estado: "conectado", telefone: "5547999990000", nomePerfil: "Operação" });
    const erro = await c.estado("omni-abc123").catch((e: Error) => e);
    expect(erro).toMatchObject({ status: 401, code: "chave_recusada" });
    expect(JSON.stringify(erro) + String(erro)).not.toContain(CHAVE);
  });

  it("envio só para destino válido", async () => {
    const { c } = evolution({ "POST message/sendText/omni-abc123": [{ status: 201, body: { key: { id: "3EB0ABC", remoteJid: "5547999990000@s.whatsapp.net", fromMe: true } } }] });
    await expect(c.enviarTexto("omni-abc123", "todos", "oi")).rejects.toMatchObject({ code: "destino_invalido" });
    await expect(c.enviarTexto("omni-abc123", "5547999990000", "  ")).rejects.toMatchObject({ code: "texto_invalido" });
    expect(await c.enviarTexto("omni-abc123", "5547999990000", "Bom dia")).toEqual({ id: "3EB0ABC", jid: "5547999990000@s.whatsapp.net" });
  });
});

const upsert = (data: unknown, extra: Record<string, unknown> = {}) => ({ event: "messages.upsert", instance: "omni-abc123", data, apikey: "segredo-da-instancia", server_url: "x", ...extra });

describe("eventos do webhook", () => {
  it("texto de pessoa, com nome e hora; o apikey do corpo não sai", () => {
    const [e] = lerEventoWebhook(
      upsert({ key: { remoteJid: "5547999990000@s.whatsapp.net", fromMe: false, id: "M1" }, pushName: "João", message: { conversation: "Bom dia, a equipe chega que horas?" }, messageTimestamp: 1793800000 }),
    );
    expect(e).toEqual({
      tipo: "mensagem",
      instancia: "omni-abc123",
      chatJid: "5547999990000@s.whatsapp.net",
      lid: null,
      grupo: false,
      telefone: "5547999990000",
      id: "M1",
      deMim: false,
      autorJid: "5547999990000@s.whatsapp.net",
      autorNome: "João",
      conteudo: "texto",
      texto: "Bom dia, a equipe chega que horas?",
      arquivo: null,
      em: new Date(1793800000 * 1000),
      citada: null,
      encaminhada: false,
      mencoes: [],
    });
    expect(JSON.stringify(e)).not.toContain("segredo-da-instancia");
  });

  it("a mesma pessoa pelo @lid ou pelo número cai na mesma conversa (a do número), com o @lid à parte", () => {
    const [porLid] = lerEventoWebhook(
      upsert({ key: { remoteJid: "123456789012345@lid", remoteJidAlt: "5547999990000@s.whatsapp.net", fromMe: false, id: "L1" }, pushName: "João", message: { conversation: "oi" } }),
    );
    const [porNumero] = lerEventoWebhook(
      upsert({ key: { remoteJid: "5547999990000@s.whatsapp.net", remoteJidAlt: "123456789012345@lid", fromMe: true, id: "L2" }, message: { conversation: "olá" } }),
    );
    const [soLid] = lerEventoWebhook(upsert({ key: { remoteJid: "123456789012345:7@lid", fromMe: false, id: "L3" }, message: { conversation: "?" } }));
    expect(porLid).toMatchObject({ chatJid: "5547999990000@s.whatsapp.net", lid: "123456789012345@lid", telefone: "5547999990000", autorJid: "5547999990000@s.whatsapp.net" });
    expect(porNumero).toMatchObject({ chatJid: "5547999990000@s.whatsapp.net", lid: "123456789012345@lid", autorJid: null });
    expect(soLid).toMatchObject({ chatJid: "123456789012345@lid", lid: "123456789012345@lid", telefone: null });
  });

  it("grupo com autor @lid e número alternativo; documento com legenda dentro de mensagem temporária; mensagem minha", () => {
    const [g] = lerEventoWebhook(
      upsert({
        key: { remoteJid: "120363000000000001@g.us", fromMe: false, id: "G1", participant: "123456789012345@lid", participantAlt: "5547988887777@s.whatsapp.net" },
        pushName: "Líder de campo",
        message: { ephemeralMessage: { message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: "RDO 23.pdf", caption: "Segue o RDO", url: "https://mmg.whatsapp.net/x", mediaKey: "k" } } } } } },
      }),
    );
    expect(g).toMatchObject({ grupo: true, telefone: null, autorJid: "5547988887777@s.whatsapp.net", conteudo: "documento", texto: "Segue o RDO", arquivo: "RDO 23.pdf" });
    expect(JSON.stringify(g)).not.toContain("mmg.whatsapp.net");

    const [eu] = lerEventoWebhook({ event: "SEND_MESSAGE", instance: "omni-abc123", data: { key: { remoteJid: "5547999990000@s.whatsapp.net", fromMe: true, id: "M2" }, message: { extendedTextMessage: { text: "Chegamos 8h." } } } });
    expect(eu).toMatchObject({ deMim: true, autorJid: null, autorNome: null, texto: "Chegamos 8h." });
  });

  it("ignora status, reações, protocolo, instância de fora e corpo inválido", () => {
    expect(lerEventoWebhook(upsert({ key: { remoteJid: "status@broadcast", fromMe: false, id: "S" }, message: { conversation: "story" } }))).toEqual([]);
    expect(lerEventoWebhook(upsert({ key: { remoteJid: "5547999990000@s.whatsapp.net", fromMe: false, id: "R" }, message: { reactionMessage: { text: "👍" } } }))).toEqual([]);
    expect(lerEventoWebhook(upsert({ key: { remoteJid: "5547999990000@s.whatsapp.net", fromMe: false, id: "P" }, message: { protocolMessage: { type: 0 }, messageContextInfo: {} } }))).toEqual([]);
    expect(lerEventoWebhook(upsert({ key: { remoteJid: "5547999990000@s.whatsapp.net", fromMe: false, id: "X" }, message: { conversation: "oi" } }, { instance: "prisma-vendas" }))).toEqual([]);
    expect(lerEventoWebhook("lixo")).toEqual([]);
  });

  it("status de entrega e conexão do aparelho", () => {
    expect(lerEventoWebhook({ event: "messages.update", instance: "omni-abc123", data: { keyId: "M2", remoteJid: "5547999990000@s.whatsapp.net", fromMe: true, status: "READ" } })).toEqual([
      { tipo: "status", instancia: "omni-abc123", chatJid: "5547999990000@s.whatsapp.net", id: "M2", status: "lida" },
    ]);
    expect(lerEventoWebhook({ event: "connection.update", instance: "omni-abc123", data: { instance: "omni-abc123", state: "open", wuid: "5547999990000@s.whatsapp.net", profileName: "Operação" } })).toEqual([
      { tipo: "conexao", instancia: "omni-abc123", estado: "conectado", telefone: "5547999990000", nomePerfil: "Operação" },
    ]);
  });
});

describe("histórico e mídia", () => {
  it("contatos: nome salvo na agenda (também pelo @lid), foto e o outro identificador (patch-lid); o próprio número não conta como nome; grupos e status de fora", async () => {
    const { c } = evolution({
      "POST chat/findContacts/omni-abc123": [
        {
          status: 200,
          body: [
            { remoteJid: "123456789012345@lid", pushName: "Rogério da Obra", profilePicUrl: "https://pps.whatsapp.net/v/x.jpg", pnJid: "5547977770000@s.whatsapp.net" },
            { remoteJid: "5547999990000@s.whatsapp.net", pushName: "5547999990000", lidJid: "222222222222222@lid" },
            { remoteJid: "5547966660000@s.whatsapp.net", pushName: "Com lid inválido", lidJid: "5547966660000@s.whatsapp.net" },
            { remoteJid: "5547988880000@s.whatsapp.net", pushName: "+55 47 98888-0000" },
            { remoteJid: "120363000000000001@g.us", pushName: "Grupo" },
            { remoteJid: "status@broadcast", pushName: "x" },
          ],
        },
      ],
    });
    expect(await c.contatos("omni-abc123")).toEqual([
      { jid: "123456789012345@lid", nome: "Rogério da Obra", foto: "https://pps.whatsapp.net/v/x.jpg", outro: "5547977770000@s.whatsapp.net" },
      { jid: "5547999990000@s.whatsapp.net", nome: null, foto: null, outro: "222222222222222@lid" },
      { jid: "5547966660000@s.whatsapp.net", nome: "Com lid inválido", foto: null, outro: null },
      { jid: "5547988880000@s.whatsapp.net", nome: null, foto: null, outro: null },
    ]);
  });

  it("número no WhatsApp: endereço devolvido pelo WhatsApp (sem o 9), inexistente e entrada inválida de fora", async () => {
    const { c, chamadas } = evolution({
      "POST chat/whatsappNumbers/omni-abc123": [
        {
          status: 200,
          body: [
            { exists: true, jid: "554799990000@s.whatsapp.net", number: "5547999990000" },
            { exists: false, jid: "5547911110000@s.whatsapp.net", number: "5547911110000" },
          ],
        },
      ],
    });
    expect(await c.numerosNoWhatsApp("omni-abc123", ["5547999990000", "5547911110000", "abc"])).toEqual([
      { numero: "5547999990000", existe: true, jid: "554799990000@s.whatsapp.net" },
      { numero: "5547911110000", existe: false, jid: "5547911110000@s.whatsapp.net" },
    ]);
    expect(chamadas[0]!.body).toEqual({ numbers: ["5547999990000", "5547911110000"] });
    expect(await c.numerosNoWhatsApp("omni-abc123", ["12"])).toEqual([]);
  });

  it("conversas sem repetir; nome do grupo pela consulta; mensagens filtradas por grupo e data; mídia em bytes", async () => {
    const { c, chamadas } = evolution({
      "POST chat/findChats/omni-abc123": [
        {
          status: 200,
          body: [
            { remoteJid: "120363000000000001@g.us", pushName: "Missão 5851 - Oceanis", profilePicUrl: "https://pps.whatsapp.net/v/t61/g.jpg?oe=1" },
            { remoteJid: "5547999990000@s.whatsapp.net", profilePicUrl: "http://exemplo.com/x.jpg" },
            { remoteJid: "status@broadcast" },
            { remoteJid: "120363000000000001@g.us" },
          ],
        },
      ],
      "GET group/findGroupInfos/omni-abc123?groupJid=120363000000000001%40g.us": [{ status: 200, body: { id: "120363000000000001@g.us", subject: " Missão 5851 - Oceanis ", size: 12 } }],
      "POST chat/findMessages/omni-abc123": [{ status: 200, body: { messages: { total: 1, pages: 1, currentPage: 1, records: [{ key: { remoteJid: "120363000000000001@g.us", fromMe: false, id: "H1", participant: "5547911110000@s.whatsapp.net" }, pushName: "Líder", message: { conversation: "Chegamos" }, messageTimestamp: 1793000000 }] } } }],
      "POST chat/getBase64FromMediaMessage/omni-abc123": [{ status: 201, body: { base64: Buffer.from("pdf").toString("base64"), mimetype: "application/pdf; charset=binary", fileName: "RDO.pdf" } }],
    });
    expect(await c.conversas("omni-abc123")).toEqual([
      { jid: "120363000000000001@g.us", grupo: true, nome: "Missão 5851 - Oceanis", foto: "https://pps.whatsapp.net/v/t61/g.jpg?oe=1", ultimaEm: null },
      { jid: "5547999990000@s.whatsapp.net", grupo: false, nome: null, foto: null, ultimaEm: null },
    ]);
    expect(await c.infoGrupo("omni-abc123", "120363000000000001@g.us")).toEqual({ nome: "Missão 5851 - Oceanis", participantes: 12 });
    const pagina = await c.mensagens("omni-abc123", { jid: "120363000000000001@g.us", desde: new Date(1792000000 * 1000) }, 2, 500);
    expect(chamadas.find((x) => x.rota.startsWith("chat/findMessages"))!.body).toEqual({
      where: { key: { remoteJid: "120363000000000001@g.us" }, messageTimestamp: { gte: 1792000000 } },
      page: 2,
      offset: 200,
    });
    expect(lerMensagemEvolution("omni-abc123", pagina.registros[0])).toMatchObject({ chatJid: "120363000000000001@g.us", grupo: true, autorNome: "Líder", texto: "Chegamos" });
    const m = await c.midia("omni-abc123", "3EB0ABCDEF");
    expect([m.conteudo.toString(), m.mimetype, m.nome]).toEqual(["pdf", "application/pdf", "RDO.pdf"]);
    await expect(c.infoGrupo("omni-abc123", "5547999990000@s.whatsapp.net")).rejects.toBeInstanceOf(WhatsAppError);
  });

  it("mensagem de voz: convertida pela Evolution (encoding), destino e tamanho conferidos", async () => {
    const { c, chamadas } = evolution({ "POST message/sendWhatsAppAudio/omni-abc123": [{ status: 201, body: { key: { id: "VOZ1", remoteJid: "5547999990000@s.whatsapp.net" } } }] });
    expect(await c.enviarAudio("omni-abc123", "5547999990000", Buffer.from("webm"))).toEqual({ id: "VOZ1", jid: "5547999990000@s.whatsapp.net" });
    expect(chamadas[0]!.body).toEqual({ number: "5547999990000", audio: Buffer.from("webm").toString("base64"), encoding: true, delay: 0 });
    await expect(c.enviarAudio("omni-abc123", "abc", Buffer.from("x"))).rejects.toThrow(WhatsAppError);
    await expect(c.enviarAudio("omni-abc123", "5547999990000", Buffer.alloc(0))).rejects.toThrow(WhatsAppError);
  });

  it("envio de arquivo: tipo pelo mimetype, conteúdo em base64, limite de tamanho", async () => {
    const { c, chamadas } = evolution({ "POST message/sendMedia/omni-abc123": [{ status: 201, body: { key: { id: "3EB0F1", remoteJid: "120363000000000001@g.us" } } }] });
    const r = await c.enviarArquivo("omni-abc123", "120363000000000001@g.us", { conteudo: Buffer.from("pdf"), mimetype: "application/pdf", nome: "Medição.pdf", legenda: "Segue a medição" });
    expect(r).toEqual({ id: "3EB0F1", jid: "120363000000000001@g.us" });
    expect(chamadas[0]!.body).toMatchObject({ number: "120363000000000001@g.us", mediatype: "document", mimetype: "application/pdf", caption: "Segue a medição", media: Buffer.from("pdf").toString("base64"), fileName: "Medição.pdf" });
    await expect(c.enviarArquivo("omni-abc123", "120363000000000001@g.us", { conteudo: Buffer.alloc(16 * 1024 * 1024 + 1), mimetype: "image/png", nome: "x.png" })).rejects.toMatchObject({ code: "arquivo_invalido" });
  });
});

describe("ações nas mensagens pelo webhook (0087)", () => {
  const upsert = (message: Record<string, unknown>, key: Record<string, unknown> = {}) =>
    lerEventoWebhook({ event: "messages.upsert", instance: "omni-teste01", data: { key: { remoteJid: "5547900000078@s.whatsapp.net", fromMe: false, id: "M2", ...key }, pushName: "Bruno", message, messageTimestamp: 1764100000 } });

  it("resposta citada e encaminhada", () => {
    const [e] = upsert({ extendedTextMessage: { text: "Pode", contextInfo: { stanzaId: "M1", participant: "5547900000011@s.whatsapp.net", quotedMessage: { conversation: "Posso ir amanhã?" }, isForwarded: true } } });
    expect(e).toMatchObject({ tipo: "mensagem", texto: "Pode", citada: { id: "M1", texto: "Posso ir amanhã?", autorJid: "5547900000011@s.whatsapp.net" }, encaminhada: true });
    const [foto] = upsert({ conversation: "ok", extendedTextMessage: undefined, imageMessage: undefined, contextInfo: undefined });
    expect(foto).toMatchObject({ citada: null, encaminhada: false });
  });

  it("o que não se mostra não vira mensagem (a conversa não sobe); álbum, vídeo redondo e mensagem de empresa viram", () => {
    for (const nada of [
      { secretEncryptedMessage: { secretEncType: 2, encPayload: "x", encIv: "y" }, messageContextInfo: {} },
      { messageHistoryNotice: {}, messageContextInfo: {} },
      { albumMessage: { expectedImageCount: 3 } },
      { senderKeyDistributionMessage: {}, messageContextInfo: {} },
      { messageContextInfo: {} },
    ]) expect(upsert(nada)).toEqual([]);
    expect(upsert({ associatedChildMessage: { message: { imageMessage: { caption: "Obra" } } } })[0]).toMatchObject({ tipo: "mensagem", conteudo: "imagem", texto: "Obra" });
    expect(upsert({ ptvMessage: {} })[0]).toMatchObject({ conteudo: "video" });
    expect(upsert({ templateMessage: { hydratedTemplate: { hydratedContentText: "Seu pedido saiu" } } })[0]).toMatchObject({ conteudo: "texto", texto: "Seu pedido saiu" });
    expect(upsert({ interactiveMessage: { body: { text: "Escolha uma opção" } } })[0]).toMatchObject({ conteudo: "texto", texto: "Escolha uma opção" });
    expect(upsert({ pollCreationMessage: { name: "Enquete" } })[0]).toMatchObject({ conteudo: "outro" });
  });

  it("marcações no grupo: os JIDs de mentionedJid, sem repetir e só de pessoa", () => {
    const [e] = upsert(
      { extendedTextMessage: { text: "@222222222222222 e @5547900000012, olhem", contextInfo: { mentionedJid: ["222222222222222@lid", "5547900000012@s.whatsapp.net", "222222222222222@lid", "120363000000000001@g.us", 7] } } },
      { remoteJid: "120363000000000001@g.us", participant: "5547900000011@s.whatsapp.net" },
    );
    expect(e).toMatchObject({ tipo: "mensagem", mencoes: ["222222222222222@lid", "5547900000012@s.whatsapp.net"] });
  });

  it("reação (e tirar a reação), num grupo com o participante", () => {
    const grupo = { remoteJid: "120363000000000001@g.us", participant: "5547900000011@s.whatsapp.net" };
    expect(upsert({ reactionMessage: { key: { id: "M1" }, text: "👍" } }, grupo)).toEqual([
      expect.objectContaining({ tipo: "reacao", chatJid: "120363000000000001@g.us", alvoId: "M1", emoji: "👍", autorJid: "5547900000011@s.whatsapp.net", deMim: false }),
    ]);
    expect(upsert({ reactionMessage: { key: { id: "M1" }, text: "" } }, grupo)[0]).toMatchObject({ tipo: "reacao", emoji: "" });
  });

  it("apagada e editada (na mensagem de protocolo e nos eventos à parte da Evolution) e fixada", () => {
    expect(upsert({ protocolMessage: { key: { id: "M1" }, type: "REVOKE" } })[0]).toMatchObject({ tipo: "apagada", id: "M1", chatJid: "5547900000078@s.whatsapp.net" });
    expect(upsert({ protocolMessage: { key: { id: "M1" }, type: 14, editedMessage: { conversation: "Corrigido" } } })[0]).toMatchObject({ tipo: "edicao", id: "M1", texto: "Corrigido" });
    expect(lerEventoWebhook({ event: "MESSAGES_DELETE", instance: "omni-teste01", data: { remoteJid: "5547900000078@s.whatsapp.net", fromMe: true, id: "M9" } })).toEqual([
      { tipo: "apagada", instancia: "omni-teste01", chatJid: "5547900000078@s.whatsapp.net", lid: null, id: "M9" },
    ]);
    expect(
      lerEventoWebhook({ event: "messages.edited", instance: "omni-teste01", data: { key: { remoteJid: "120363000000000001@g.us", fromMe: false, id: "M3" }, type: 14, editedMessage: { extendedTextMessage: { text: "Novo" } } } }),
    ).toEqual([expect.objectContaining({ tipo: "edicao", chatJid: "120363000000000001@g.us", id: "M3", texto: "Novo" })]);
    expect(upsert({ pinInChatMessage: { key: { id: "M1" }, type: 1 } })[0]).toMatchObject({ tipo: "fixada", id: "M1", fixar: true });
    expect(upsert({ pinInChatMessage: { key: { id: "M1" }, type: 2 } })[0]).toMatchObject({ tipo: "fixada", fixar: false });
  });
});

describe("ponte de ações", () => {
  it("manda o token e a ação; devolve só os contatos válidos; erro com o código da ponte", async () => {
    const pedidos: Array<{ url: string; corpo: unknown; auth: string | null }> = [];
    const respostas = [
      { status: 200, corpo: { contatos: [{ jid: "5547900000011@s.whatsapp.net", lid: null, telefone: "5547900000011@s.whatsapp.net", nome: "Ana" }, { jid: "x", nome: "" }] } },
      { status: 409, corpo: { erro: "linha_indisponivel" } },
    ];
    const f = (async (url: string, init: RequestInit) => {
      pedidos.push({ url, corpo: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      const r = respostas.shift()!;
      return new Response(JSON.stringify(r.corpo), { status: r.status });
    }) as unknown as typeof fetch;
    const p = new PonteDeAcoes({ url: "http://evolution:8099", token: "t".repeat(40), fetch: f });
    expect((await p.contatos("5547900000001")).contatos).toEqual([{ jid: "5547900000011@s.whatsapp.net", lid: null, telefone: "5547900000011@s.whatsapp.net", nome: "Ana" }]);
    expect(pedidos[0]).toEqual({ url: "http://evolution:8099/v1/acoes", corpo: { telefone: "5547900000001", acao: "contatos", recarregar: false }, auth: `Bearer ${"t".repeat(40)}` });
    await expect(p.salvarContato("5547900000001", "5547900000011@s.whatsapp.net", "Ana")).rejects.toMatchObject({ status: 409, code: "linha_indisponivel" });
    expect(() => new PonteDeAcoes({ url: "https://evolution:8099", token: "t".repeat(40) })).toThrow();
  });
});
