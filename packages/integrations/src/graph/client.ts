import { createSign, randomUUID } from "node:crypto";

import { z } from "zod";

/**
 * Microsoft Graph pelo app "Omni – Integrações" (Fase 4), só no servidor.
 *
 * - Token de aplicativo (client credentials) com asserção assinada pelo
 *   certificado: a chave privada nunca sai do servidor, nada de segredo.
 * - SharePoint por `driveId` + id do item (nunca pelo caminho textual).
 * - A permissão do app no site (Sites.Selected) não substitui a do Omni: quem
 *   chama confere antes a pessoa e, aqui, que o item está dentro da pasta autorizada.
 * - Token e chave nunca aparecem em mensagens de erro nem em log.
 */

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** Código interno do erro (`innerError.code`), ex.: GraphAccessToTranscriptsDisabled. */
    readonly codigoInterno?: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

export type GraphClientOptions = {
  tenantId: string;
  clientId: string;
  /** Chave privada PEM do certificado. */
  privateKeyPem: string;
  /** Impressão SHA-256 do certificado, em hexadecimal. */
  thumbprintSha256: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
};

export type ItemDrive = {
  id: string;
  nome: string;
  tipo: "pasta" | "arquivo";
  tamanho: number | null;
  modificadoEm: string | null;
  /** Quantidade de itens, nas pastas. */
  filhos: number | null;
  mime: string | null;
  webUrl: string | null;
};

const itemSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().nullable().optional(),
  lastModifiedDateTime: z.string().nullable().optional(),
  webUrl: z.string().nullable().optional(),
  folder: z.object({ childCount: z.number().optional() }).nullable().optional(),
  file: z.object({ mimeType: z.string().optional() }).nullable().optional(),
  parentReference: z.object({ id: z.string().optional(), driveId: z.string().optional() }).nullable().optional(),
});
type ItemGraph = z.infer<typeof itemSchema>;

const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "id,name,size,lastModifiedDateTime,webUrl,folder,file,parentReference";
/** Ids do Graph são opacos, mas só usam estes caracteres; recusa o resto antes de montar a URL. */
const ID_SEGURO = /^[A-Za-z0-9!_.,-]{1,300}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pessoa do Entra, só o que o Omni usa para a lista de Pessoas. */
export type UsuarioEntra = { id: string; nome: string | null; email: string | null; ativa: boolean; convidada: boolean };
const SELECT_USUARIO = "id,displayName,mail,userPrincipalName,accountEnabled,userType";
const usuarioSchema = z
  .object({
    id: z.string(),
    displayName: z.string().nullable().optional(),
    mail: z.string().nullable().optional(),
    userPrincipalName: z.string().nullable().optional(),
    accountEnabled: z.boolean().nullable().optional(),
    userType: z.string().nullable().optional(),
  })
  .loose();
function paraUsuario(u: z.infer<typeof usuarioSchema>): UsuarioEntra {
  const upn = u.userPrincipalName && !u.userPrincipalName.includes("#EXT#") ? u.userPrincipalName : null;
  return {
    id: u.id,
    nome: u.displayName?.trim() || null,
    email: (u.mail ?? upn)?.trim().toLowerCase() || null,
    ativa: u.accountEnabled !== false,
    convidada: u.userType === "Guest" || Boolean(u.userPrincipalName?.includes("#EXT#")),
  };
}
const MAX_NIVEIS = 30;
const EMAIL = /^[^@\s/?#]+@[^@\s/?#]+\.[^@\s/?#]+$/;
const ID_MENSAGEM = /^[A-Za-z0-9_=+\/-]{10,600}$/;
const SELECT_EMAIL = "id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,hasAttachments,isRead,body";
/** Corpo em texto puro: a tela nunca recebe HTML de e-mail. */
const PREFER_TEXTO = { Prefer: 'outlook.body-content-type="text", odata.maxpagesize=50' };

const destinatarioSchema = z.object({ emailAddress: z.object({ name: z.string().nullable().optional(), address: z.string().nullable().optional() }) });
const mensagemSchema = z.object({
  id: z.string(),
  internetMessageId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  from: destinatarioSchema.nullable().optional(),
  toRecipients: z.array(destinatarioSchema).optional(),
  ccRecipients: z.array(destinatarioSchema).optional(),
  receivedDateTime: z.string().nullable().optional(),
  sentDateTime: z.string().nullable().optional(),
  bodyPreview: z.string().nullable().optional(),
  hasAttachments: z.boolean().optional(),
  isRead: z.boolean().optional(),
  body: z.object({ contentType: z.string().optional(), content: z.string().nullable().optional() }).nullable().optional(),
});
export type MensagemGraph = z.infer<typeof mensagemSchema>;
export type PastaDeEmail = { id: string; nome: string; sistema: "inbox" | "sentitems" | "drafts" | "archive" | "deleteditems" | "junkemail" | null; naoLidas: number; total: number };
export type ResumoDeEmail = {
  id: string;
  assunto: string;
  de: { nome: string | null; endereco: string } | null;
  para: { nome: string | null; endereco: string }[];
  em: string | null;
  previa: string;
  anexos: boolean;
  lida: boolean;
  importante: boolean;
  rascunho: boolean;
};

const pessoaAgendaSchema = z.object({ emailAddress: z.object({ name: z.string().nullable().optional(), address: z.string().nullable().optional() }) });
const eventoSchema = z.object({
  id: z.string(),
  iCalUId: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  start: z.object({ dateTime: z.string() }),
  end: z.object({ dateTime: z.string() }),
  isCancelled: z.boolean().optional(),
  isOnlineMeeting: z.boolean().optional(),
  onlineMeeting: z.object({ joinUrl: z.string().nullable().optional() }).nullable().optional(),
  organizer: pessoaAgendaSchema.nullable().optional(),
  attendees: z.array(pessoaAgendaSchema).optional(),
  bodyPreview: z.string().nullable().optional(),
});
export type EventoAgenda = z.infer<typeof eventoSchema>;

/** `html`, quando vem, é o corpo enviado (avisos do sistema); senão, texto puro. */
/** Anexo de e-mail enviado (vai no próprio pedido: até ~3 MB no total, o limite do Graph é 4 MB por pedido). */
export type AnexoParaEnviar = { nome: string; tipo: string; conteudo: Buffer };
export type EmailParaEnviar = { assunto: string; texto: string; html?: string; para: string[]; cc: string[]; cco: string[]; anexos?: AnexoParaEnviar[] };
const anexosDoGraph = (anexos: AnexoParaEnviar[] | undefined) =>
  (anexos ?? []).map((a) => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: a.nome, contentType: a.tipo, contentBytes: a.conteudo.toString("base64") }));
const destinatario = (endereco: string) => {
  if (!EMAIL.test(endereco)) throw new GraphError("Destinatário inválido", 400, "invalidRecipient");
  return { emailAddress: { address: endereco } };
};

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function paraItem(i: ItemGraph): ItemDrive {
  return {
    id: i.id,
    nome: i.name,
    tipo: i.folder ? "pasta" : "arquivo",
    tamanho: i.size ?? null,
    modificadoEm: i.lastModifiedDateTime ?? null,
    filhos: i.folder?.childCount ?? null,
    mime: i.file?.mimeType ?? null,
    webUrl: i.webUrl ?? null,
  };
}

export class GraphClient {
  private readonly o: Required<Omit<GraphClientOptions, "fetch" | "sleep" | "now" | "maxRetries">>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private token: { valor: string; ate: number } | null = null;

  constructor(options: GraphClientOptions) {
    if (!/^[a-f0-9]{64}$/i.test(options.thumbprintSha256)) throw new Error("Impressão SHA-256 do certificado inválida");
    this.o = { tenantId: options.tenantId, clientId: options.clientId, privateKeyPem: options.privateKeyPem, thumbprintSha256: options.thumbprintSha256 };
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /** Asserção JWT (RS256) do certificado, válida por 10 minutos. */
  private assercao(endpoint: string): string {
    const agora = Math.floor(this.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", "x5t#S256": b64url(Buffer.from(this.o.thumbprintSha256, "hex")) };
    const payload = { aud: endpoint, iss: this.o.clientId, sub: this.o.clientId, jti: randomUUID(), nbf: agora, iat: agora, exp: agora + 600 };
    const corpo = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const assinatura = createSign("RSA-SHA256").update(corpo).sign(this.o.privateKeyPem);
    return `${corpo}.${b64url(assinatura)}`;
  }

  private async tokenDeAcesso(): Promise<string> {
    if (this.token && this.token.ate > this.now()) return this.token.valor;
    const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(this.o.tenantId)}/oauth2/v2.0/token`;
    const resposta = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.o.clientId,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: this.assercao(endpoint),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const corpo = (await resposta.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!resposta.ok || !corpo.access_token) {
      throw new GraphError(`Entra recusou o token do Graph (${corpo.error ?? resposta.status})`, resposta.status, corpo.error);
    }
    // Renova 5 minutos antes de vencer.
    this.token = { valor: corpo.access_token, ate: this.now() + Math.max(60, (corpo.expires_in ?? 3600) - 300) * 1000 };
    return this.token.valor;
  }

  /** GET no Graph com novas tentativas (429/503 respeitam Retry-After). */
  private async get(url: string, init: { redirect?: "follow" | "manual"; headers?: Record<string, string> } = {}): Promise<Response> {
    for (let tentativa = 0; ; tentativa += 1) {
      const resposta = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${await this.tokenDeAcesso()}`, Accept: "application/json", ...init.headers },
        redirect: init.redirect ?? "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (resposta.ok || (init.redirect === "manual" && resposta.status >= 300 && resposta.status < 400)) return resposta;
      if ((resposta.status === 429 || resposta.status === 503 || resposta.status === 504) && tentativa < this.maxRetries) {
        const espera = Number(resposta.headers.get("retry-after"));
        await this.sleep((Number.isFinite(espera) && espera > 0 ? espera : 2 ** tentativa) * 1000);
        continue;
      }
      if (resposta.status === 401 && tentativa === 0) {
        this.token = null; // token revogado ou vencido antes da hora: tenta uma vez com outro
        continue;
      }
      const corpo = (await resposta.json().catch(() => ({}))) as { error?: { code?: string; innerError?: { code?: string } } };
      throw new GraphError(
        `Graph respondeu ${resposta.status}${corpo.error?.code ? ` (${corpo.error.code})` : ""}`,
        resposta.status,
        corpo.error?.code,
        corpo.error?.innerError?.code,
      );
    }
  }

  private url(driveId: string, itemId: string, sufixo = ""): string {
    if (!ID_SEGURO.test(driveId) || !ID_SEGURO.test(itemId)) throw new GraphError("Identificador do SharePoint inválido", 400, "invalidId");
    return `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}${sufixo}`;
  }

  async item(driveId: string, itemId: string): Promise<ItemDrive & { paiId: string | null; driveDoPai: string | null }> {
    const i = itemSchema.parse(await (await this.get(`${this.url(driveId, itemId)}?$select=${SELECT}`)).json());
    return { ...paraItem(i), paiId: i.parentReference?.id ?? null, driveDoPai: i.parentReference?.driveId ?? null };
  }

  /** Conteúdo de uma pasta, todas as páginas (pastas primeiro, depois por nome). */
  async listarFilhos(driveId: string, pastaId: string): Promise<ItemDrive[]> {
    const itens: ItemDrive[] = [];
    let proxima: string | null = `${this.url(driveId, pastaId, "/children")}?$select=${SELECT}&$top=200`;
    for (let pagina = 0; proxima && pagina < 50; pagina += 1) {
      // O próximo link vem do Graph; só segue se for o próprio Graph.
      if (!proxima.startsWith(`${GRAPH}/`)) throw new GraphError("Paginação do Graph com endereço inesperado", 502);
      const corpo = z
        .object({ value: z.array(itemSchema), "@odata.nextLink": z.string().optional() })
        .parse(await (await this.get(proxima)).json());
      itens.push(...corpo.value.map(paraItem));
      proxima = corpo["@odata.nextLink"] ?? null;
    }
    return itens.sort((a, b) => (a.tipo === b.tipo ? a.nome.localeCompare(b.nome, "pt-BR") : a.tipo === "pasta" ? -1 : 1));
  }

  /**
   * Caminho da pasta autorizada até o item (inclusive), subindo pelos pais.
   * `null` quando o item não está dentro dela (ou está em outra biblioteca).
   */
  async caminhoDentro(driveId: string, raizId: string, itemId: string): Promise<{ id: string; nome: string }[] | null> {
    const caminho: { id: string; nome: string }[] = [];
    let atual = itemId;
    for (let nivel = 0; nivel < MAX_NIVEIS; nivel += 1) {
      const i = await this.item(driveId, atual);
      caminho.unshift({ id: i.id, nome: i.nome });
      if (i.id === raizId) return caminho;
      if (!i.paiId || (i.driveDoPai && i.driveDoPai !== driveId)) return null;
      atual = i.paiId;
    }
    return null;
  }

  // ---------------------------------------------------------------- Outlook (e-mails da missão)

  private caixa(email: string): string {
    if (!EMAIL.test(email)) throw new GraphError("Caixa de e-mail inválida", 400, "invalidMailbox");
    return `${GRAPH}/users/${encodeURIComponent(email)}`;
  }

  /**
   * Leitura incremental de uma pasta (`inbox` ou `sentitems`): na primeira vez,
   * os e-mails recebidos desde `desde`; depois, só as mudanças. Lê até
   * `maxPaginas` páginas por chamada: se sobrar, devolve `continuar` (guarde e
   * chame de novo); no fim, `deltaLink` (guarde para a próxima rodada).
   */
  async mensagensDelta(
    caixa: string,
    pasta: "inbox" | "sentitems",
    link: string | null,
    opcoes: { desde: Date; maxPaginas?: number },
  ): Promise<{ mensagens: MensagemGraph[]; removidas: string[]; continuar: string | null; deltaLink: string | null }> {
    let url =
      link ??
      `${this.caixa(caixa)}/mailFolders/${pasta}/messages/delta?$select=${SELECT_EMAIL}&$filter=${encodeURIComponent(`receivedDateTime ge ${opcoes.desde.toISOString()}`)}`;
    const mensagens: MensagemGraph[] = [];
    const removidas: string[] = [];
    for (let pagina = 0; pagina < (opcoes.maxPaginas ?? 40); pagina += 1) {
      if (!url.startsWith(`${GRAPH}/`)) throw new GraphError("Paginação do Graph com endereço inesperado", 502);
      const corpo = z
        .object({ value: z.array(z.record(z.string(), z.unknown())), "@odata.nextLink": z.string().optional(), "@odata.deltaLink": z.string().optional() })
        .parse(await (await this.get(url, { headers: PREFER_TEXTO })).json());
      for (const item of corpo.value) {
        if (item["@removed"]) removidas.push(String(item.id));
        else mensagens.push(mensagemSchema.parse(item));
      }
      if (corpo["@odata.deltaLink"]) return { mensagens, removidas, continuar: null, deltaLink: corpo["@odata.deltaLink"] };
      if (!corpo["@odata.nextLink"]) return { mensagens, removidas, continuar: null, deltaLink: null };
      url = corpo["@odata.nextLink"];
    }
    return { mensagens, removidas, continuar: url, deltaLink: null };
  }

  /** Um e-mail para ler na tela: corpo em texto puro (sem HTML) e os anexos. */
  async mensagem(
    caixa: string,
    id: string,
  ): Promise<MensagemGraph & { anexos: { id: string; nome: string; tamanho: number | null; inline: boolean; arquivo: boolean; mime: string | null; contentId: string | null }[] }> {
    if (!ID_MENSAGEM.test(id)) throw new GraphError("Identificador do e-mail inválido", 400, "invalidId");
    const base = `${this.caixa(caixa)}/messages/${encodeURIComponent(id)}`;
    const m = mensagemSchema.parse(await (await this.get(`${base}?$select=${SELECT_EMAIL}`, { headers: PREFER_TEXTO })).json());
    // Sempre: o Outlook marca hasAttachments=false quando só há imagens no corpo (a
    // assinatura); sem a lista, as imagens "cid:" não aparecem.
    const anexos = z
          .object({
            value: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                size: z.number().nullable().optional(),
                isInline: z.boolean().optional(),
                contentType: z.string().nullable().optional(),
                contentId: z.string().nullable().optional(),
                "@odata.type": z.string().optional(),
              }),
            ),
          })
          .parse(await (await this.get(`${base}/attachments?$select=id,name,size,isInline,contentType,microsoft.graph.fileAttachment/contentId`)).json())
          .value.map((a) => ({
            id: a.id,
            nome: a.name,
            tamanho: a.size ?? null,
            inline: Boolean(a.isInline),
            // Só anexos de arquivo podem ser baixados (e-mail ou item anexado, não).
            arquivo: (a["@odata.type"] ?? "#microsoft.graph.fileAttachment") === "#microsoft.graph.fileAttachment",
            mime: a.contentType ?? null,
            // Imagens da assinatura e do corpo: o HTML as cita como "cid:<contentId>".
            contentId: a.contentId?.replace(/^<|>$/g, "") ?? null,
          }));
    return { ...m, anexos };
  }

  /** Corpo do e-mail em HTML (para limpar no servidor antes de mostrar); null se não houver. */
  // ------------------------------------------------ caixa de e-mail da pessoa (aba E-mails)

  /**
   * Pastas da caixa: as do sistema primeiro (Entrada, Enviados, Rascunhos, Arquivo,
   * Excluídos, Lixo eletrônico) e depois as criadas pela pessoa, com as contagens.
   */
  async pastasDeEmail(caixa: string): Promise<PastaDeEmail[]> {
    const pasta = z.object({ id: z.string(), displayName: z.string(), unreadItemCount: z.number().optional(), totalItemCount: z.number().optional(), childFolderCount: z.number().optional() }).loose();
    const sistema = ["inbox", "sentitems", "drafts", "archive", "deleteditems", "junkemail"] as const;
    const conhecidas = await Promise.all(
      sistema.map(async (nome) => {
        try {
          return { nome, id: z.object({ id: z.string() }).parse(await (await this.get(`${this.caixa(caixa)}/mailFolders/${nome}?$select=id`)).json()).id };
        } catch (error) {
          if (error instanceof GraphError && error.status === 404) return null; // ex.: caixa sem Arquivo
          throw error;
        }
      }),
    );
    const todas = await this.todasAsPaginas(`${this.caixa(caixa)}/mailFolders?$top=100&$select=id,displayName,unreadItemCount,totalItemCount,childFolderCount`, pasta, undefined, 5);
    const ordem = new Map(conhecidas.filter((c): c is { nome: (typeof sistema)[number]; id: string } => c !== null).map((c, i) => [c.id, { i, nome: c.nome }]));
    return todas
      .filter((f) => ordem.has(f.id) || !/^(Conversation History|Histórico de Conversas|Sync Issues|Problemas de Sincronização|Outbox|Caixa de Saída|RSS Feeds|RSS|Feeds RSS)/i.test(f.displayName))
      .map((f) => ({ id: f.id, nome: f.displayName, sistema: ordem.get(f.id)?.nome ?? null, naoLidas: f.unreadItemCount ?? 0, total: f.totalItemCount ?? 0 }))
      .sort((x, y) => (ordem.get(x.id)?.i ?? 99) - (ordem.get(y.id)?.i ?? 99) || x.nome.localeCompare(y.nome, "pt-BR"));
  }

  /** Mensagens de uma pasta, mais recentes primeiro, de 50 em 50; com `busca`, a pesquisa do Exchange (até 50). */
  async mensagensDaPasta(caixa: string, pastaId: string, opcoes: { inicio?: number; busca?: string } = {}): Promise<{ mensagens: ResumoDeEmail[]; haMais: boolean }> {
    if (!ID_MENSAGEM.test(pastaId)) throw new GraphError("Identificador da pasta inválido", 400, "invalidId");
    const campos = "id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,hasAttachments,isRead,importance,isDraft";
    const busca = opcoes.busca?.replace(/["\\]/g, " ").trim().slice(0, 120);
    const base = `${this.caixa(caixa)}/mailFolders/${encodeURIComponent(pastaId)}/messages?$select=${campos}&$top=50`;
    const url = busca ? `${base}&$search=${encodeURIComponent(`"${busca}"`)}` : `${base}&$orderby=receivedDateTime desc&$skip=${Math.max(0, Math.min(opcoes.inicio ?? 0, 5000))}`;
    const item = z
      .object({
        id: z.string(),
        subject: z.string().nullable().optional(),
        from: destinatarioSchema.nullable().optional(),
        toRecipients: z.array(destinatarioSchema).optional(),
        receivedDateTime: z.string().nullable().optional(),
        sentDateTime: z.string().nullable().optional(),
        bodyPreview: z.string().nullable().optional(),
        hasAttachments: z.boolean().optional(),
        isRead: z.boolean().optional(),
        importance: z.string().optional(),
        isDraft: z.boolean().optional(),
      })
      .loose();
    const corpo = z.object({ value: z.array(item), "@odata.nextLink": z.string().optional() }).parse(await (await this.get(url)).json());
    const pessoa = (d: z.infer<typeof destinatarioSchema> | null | undefined) => (d ? { nome: d.emailAddress.name ?? null, endereco: d.emailAddress.address?.toLowerCase() ?? "" } : null);
    return {
      mensagens: corpo.value.map((m) => ({
        id: m.id,
        assunto: m.subject?.trim() || "(sem assunto)",
        de: pessoa(m.from),
        para: (m.toRecipients ?? []).map((d) => pessoa(d)!),
        em: m.receivedDateTime ?? m.sentDateTime ?? null,
        previa: m.bodyPreview?.slice(0, 200) ?? "",
        anexos: Boolean(m.hasAttachments),
        lida: m.isRead !== false,
        importante: m.importance === "high",
        rascunho: Boolean(m.isDraft),
      })),
      haMais: !busca && Boolean(corpo["@odata.nextLink"]),
    };
  }

  async corpoHtml(caixa: string, id: string): Promise<string | null> {
    if (!ID_MENSAGEM.test(id)) throw new GraphError("Identificador do e-mail inválido", 400, "invalidId");
    const m = z
      .object({ body: z.object({ contentType: z.string(), content: z.string().nullable() }).nullable().optional() })
      .parse(await (await this.get(`${this.caixa(caixa)}/messages/${encodeURIComponent(id)}?$select=body`, { headers: { Prefer: 'outlook.body-content-type="html"' } })).json());
    return m.body?.contentType?.toLowerCase() === "html" ? (m.body.content ?? null) : null;
  }

  /**
   * POST no Graph para envio. Só tenta de novo no 429 (o pedido foi recusado
   * antes de processar); em 5xx não repete, para não mandar o e-mail duas vezes.
   */
  /** `corpo` undefined: POST sem corpo (o permanentDelete recusa até `{}` com 400). */
  private async post(url: string, corpo: unknown): Promise<Response> {
    return this.escrever("POST", url, corpo);
  }

  /** POST/PATCH/DELETE: só repete no 429 (recusado antes de processar). */
  private async escrever(metodo: "POST" | "PATCH" | "DELETE", url: string, corpo: unknown): Promise<Response> {
    for (let tentativa = 0; ; tentativa += 1) {
      const resposta = await this.fetchImpl(url, {
        method: metodo,
        headers: { Authorization: `Bearer ${await this.tokenDeAcesso()}`, ...(corpo === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (resposta.ok) return resposta;
      if (resposta.status === 429 && tentativa < this.maxRetries) {
        const espera = Number(resposta.headers.get("retry-after"));
        await this.sleep((Number.isFinite(espera) && espera > 0 ? espera : 2 ** tentativa) * 1000);
        continue;
      }
      const erro = (await resposta.json().catch(() => ({}))) as { error?: { code?: string } };
      throw new GraphError(`Graph respondeu ${resposta.status}${erro.error?.code ? ` (${erro.error.code})` : ""}`, resposta.status, erro.error?.code);
    }
  }

  /** Envia um e-mail novo da caixa `de` (texto puro), guardando nos Enviados. */
  async enviarEmail(de: string, e: EmailParaEnviar): Promise<void> {
    await this.post(`${this.caixa(de)}/sendMail`, {
      message: {
        subject: e.assunto,
        body: e.html ? { contentType: "HTML", content: e.html } : { contentType: "Text", content: e.texto },
        toRecipients: e.para.map(destinatario),
        ccRecipients: e.cc.map(destinatario),
        bccRecipients: e.cco.map(destinatario),
        ...(e.anexos?.length ? { attachments: anexosDoGraph(e.anexos) } : {}),
      },
      saveToSentItems: true,
    });
  }

  /** Responde no mesmo fio a um e-mail que está na caixa `de` (os destinatários são os escolhidos). */
  async responderEmail(de: string, mensagemId: string, e: Omit<EmailParaEnviar, "assunto">): Promise<void> {
    if (!ID_MENSAGEM.test(mensagemId)) throw new GraphError("Identificador do e-mail inválido", 400, "invalidId");
    await this.post(`${this.caixa(de)}/messages/${encodeURIComponent(mensagemId)}/reply`, {
      message: {
        toRecipients: e.para.map(destinatario),
        ccRecipients: e.cc.map(destinatario),
        bccRecipients: e.cco.map(destinatario),
        ...(e.anexos?.length ? { attachments: anexosDoGraph(e.anexos) } : {}),
      },
      comment: e.texto,
    });
  }

  /**
   * Marca como lido ou não lido na caixa (como no Outlook). Exige a função "Application
   * Mail.ReadWrite" do Exchange no escopo "Omni - Caixas"; sem ela, o Graph responde 403.
   */
  async marcarComoLido(caixa: string, mensagemId: string, lido: boolean): Promise<void> {
    if (!ID_MENSAGEM.test(mensagemId)) throw new GraphError("Identificador do e-mail inválido", 400, "invalidId");
    await this.escrever("PATCH", `${this.caixa(caixa)}/messages/${encodeURIComponent(mensagemId)}`, { isRead: lido });
  }

  // ---------------------------------------------------------------- avisos do Graph (e-mail novo na hora)

  /**
   * Assinatura de avisos do Graph para e-mails novos na Entrada da caixa. O Graph chama
   * `url` (HTTPS público) com o `segredo` em clientState; vale até `expira` (até ~7 dias).
   */
  async assinarEntrada(caixa: string, url: string, segredo: string, expira: Date): Promise<{ id: string; expira: Date }> {
    if (!url.startsWith("https://")) throw new GraphError("Endereço dos avisos precisa ser HTTPS", 400, "invalidUrl");
    const r = z.object({ id: z.string(), expirationDateTime: z.string() }).loose().parse(
      await (
        await this.post(`${GRAPH}/subscriptions`, {
          changeType: "created",
          notificationUrl: url,
          resource: `users/${encodeURIComponent(caixa)}/mailFolders('inbox')/messages`,
          expirationDateTime: expira.toISOString(),
          clientState: segredo,
        })
      ).json(),
    );
    return { id: r.id, expira: new Date(r.expirationDateTime) };
  }

  async renovarAssinatura(id: string, expira: Date): Promise<Date> {
    if (!UUID.test(id)) throw new GraphError("Assinatura inválida", 400, "invalidId");
    const r = z.object({ expirationDateTime: z.string() }).loose().parse(
      await (await this.escrever("PATCH", `${GRAPH}/subscriptions/${id}`, { expirationDateTime: expira.toISOString() })).json(),
    );
    return new Date(r.expirationDateTime);
  }

  /** Já apagada (404) conta como apagada. */
  async apagarAssinatura(id: string): Promise<void> {
    if (!UUID.test(id)) throw new GraphError("Assinatura inválida", 400, "invalidId");
    try {
      await this.escrever("DELETE", `${GRAPH}/subscriptions/${id}`, undefined);
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return;
      throw error;
    }
  }

  // ---------------------------------------------------------------- Teams (reuniões da missão)

  /** Eventos da agenda da caixa entre duas datas (horários em UTC), com o link do Teams quando houver. */
  async agenda(caixa: string, inicio: Date, fim: Date): Promise<EventoAgenda[]> {
    const eventos: EventoAgenda[] = [];
    let url: string | null =
      `${this.caixa(caixa)}/calendarView?startDateTime=${inicio.toISOString()}&endDateTime=${fim.toISOString()}&$top=100` +
      "&$select=id,iCalUId,subject,start,end,isCancelled,isOnlineMeeting,onlineMeeting,organizer,attendees,bodyPreview";
    for (let pagina = 0; url && pagina < 20; pagina += 1) {
      if (!url.startsWith(`${GRAPH}/`)) throw new GraphError("Paginação do Graph com endereço inesperado", 502);
      const corpo = z
        .object({ value: z.array(eventoSchema), "@odata.nextLink": z.string().optional() })
        .parse(await (await this.get(url, { headers: { Prefer: 'outlook.timezone="UTC"' } })).json());
      eventos.push(...corpo.value);
      url = corpo["@odata.nextLink"] ?? null;
    }
    return eventos;
  }

  // ------------------------------------------------ pessoas do app "Omni" no Entra (0049)

  /** Todas as páginas de uma listagem do Graph (só segue links do próprio Graph). */
  private async todasAsPaginas<T>(primeira: string, item: z.ZodType<T>, headers?: Record<string, string>, maxPaginas = 100): Promise<T[]> {
    const itens: T[] = [];
    let proxima: string | null = primeira;
    for (let pagina = 0; proxima && pagina < maxPaginas; pagina += 1) {
      if (!proxima.startsWith(`${GRAPH}/`)) throw new GraphError("Paginação do Graph com endereço inesperado", 502);
      const corpo = z
        .object({ value: z.array(item), "@odata.nextLink": z.string().optional() })
        .parse(await (await this.get(proxima, headers ? { headers } : {})).json());
      itens.push(...corpo.value);
      proxima = corpo["@odata.nextLink"] ?? null;
    }
    return itens;
  }

  /**
   * Quem está em "Usuários e grupos" do app empresarial (pelo id do aplicativo).
   * Exige Application.Read.All (aplicativo).
   */
  async atribuidosAoApp(appId: string): Promise<{ tipo: "usuario" | "grupo"; id: string }[]> {
    if (!UUID.test(appId)) throw new GraphError("Id do aplicativo inválido", 400, "invalidId");
    const lista = await this.todasAsPaginas(
      `${GRAPH}/servicePrincipals(appId='${appId}')/appRoleAssignedTo?$select=principalId,principalType&$top=999`,
      z.object({ principalId: z.string(), principalType: z.string() }).loose(),
    );
    const vistos = new Set<string>();
    return lista
      .filter((a) => UUID.test(a.principalId) && (a.principalType === "User" || a.principalType === "Group") && !vistos.has(a.principalId) && Boolean(vistos.add(a.principalId)))
      .map((a) => ({ tipo: a.principalType === "User" ? ("usuario" as const) : ("grupo" as const), id: a.principalId }));
  }

  /** Pessoas de um grupo, incluindo as de grupos dentro dele. Exige GroupMember.Read.All e User.Read.All. */
  async pessoasDoGrupo(grupoId: string): Promise<UsuarioEntra[]> {
    if (!UUID.test(grupoId)) throw new GraphError("Id do grupo inválido", 400, "invalidId");
    const lista = await this.todasAsPaginas(
      `${GRAPH}/groups/${grupoId}/transitiveMembers/microsoft.graph.user?$select=${SELECT_USUARIO}&$top=999&$count=true`,
      usuarioSchema,
      { ConsistencyLevel: "eventual" },
    );
    return lista.map(paraUsuario);
  }

  /** Uma pessoa do Entra; null se não existir mais. Exige User.Read.All. */
  async usuarioEntra(id: string): Promise<UsuarioEntra | null> {
    if (!UUID.test(id)) throw new GraphError("Id da pessoa inválido", 400, "invalidId");
    try {
      return paraUsuario(usuarioSchema.parse(await (await this.get(`${GRAPH}/users/${id}?$select=${SELECT_USUARIO}`)).json()));
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return null;
      throw error;
    }
  }

  /** Id (objeto do Entra) de uma pessoa pelo e-mail; null se não existir no tenant. */
  async usuarioId(email: string): Promise<string | null> {
    try {
      return z.object({ id: z.string() }).parse(await (await this.get(`${this.caixa(email)}?$select=id`)).json()).id;
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return null;
      throw error;
    }
  }

  /** Reunião do Teams pelo link de participação (exige a política de acesso do app para o organizador). */
  async reuniaoOnline(organizadorId: string, joinUrl: string): Promise<string | null> {
    if (!ID_SEGURO.test(organizadorId)) throw new GraphError("Identificador inválido", 400, "invalidId");
    const filtro = encodeURIComponent(`JoinWebUrl eq '${joinUrl.replace(/'/g, "''")}'`);
    const corpo = z
      .object({ value: z.array(z.object({ id: z.string() })) })
      .parse(await (await this.get(`${GRAPH}/users/${organizadorId}/onlineMeetings?$filter=${filtro}`)).json());
    return corpo.value[0]?.id ?? null;
  }

  /** Transcrições de uma reunião do Teams (403 GraphAccessToTranscriptsDisabled: acesso desligado no tenant). */
  async transcricoes(organizadorId: string, reuniaoId: string): Promise<{ id: string; criadaEm: string | null }[]> {
    const corpo = z
      .object({ value: z.array(z.object({ id: z.string(), createdDateTime: z.string().nullable().optional() })) })
      .parse(await (await this.get(`${this.reuniao(organizadorId, reuniaoId)}/transcripts`)).json());
    return corpo.value.map((t) => ({ id: t.id, criadaEm: t.createdDateTime ?? null }));
  }

  /** Conteúdo de uma transcrição em WebVTT. */
  async conteudoTranscricao(organizadorId: string, reuniaoId: string, transcricaoId: string): Promise<string> {
    if (!ID_MENSAGEM.test(transcricaoId)) throw new GraphError("Identificador inválido", 400, "invalidId");
    const r = await this.get(`${this.reuniao(organizadorId, reuniaoId)}/transcripts/${encodeURIComponent(transcricaoId)}/content?$format=text/vtt`, {
      headers: { Accept: "text/vtt" },
    });
    return r.text();
  }

  private reuniao(organizadorId: string, reuniaoId: string): string {
    if (!ID_SEGURO.test(organizadorId) || !ID_MENSAGEM.test(reuniaoId)) throw new GraphError("Identificador inválido", 400, "invalidId");
    return `${GRAPH}/users/${organizadorId}/onlineMeetings/${encodeURIComponent(reuniaoId)}`;
  }

  /** Conteúdo de um anexo de arquivo de um e-mail (para o download pelo servidor). */
  async anexo(caixa: string, mensagemId: string, anexoId: string): Promise<Response> {
    if (!ID_MENSAGEM.test(mensagemId) || !ID_MENSAGEM.test(anexoId)) throw new GraphError("Identificador do anexo inválido", 400, "invalidId");
    return this.get(`${this.caixa(caixa)}/messages/${encodeURIComponent(mensagemId)}/attachments/${encodeURIComponent(anexoId)}/$value`, {
      headers: { Accept: "*/*" },
    });
  }

  /**
   * Download pelo servidor. O Graph redireciona para um endereço temporário já
   * autorizado: segue sem enviar o token para fora do Graph.
   */
  /** Conteúdo de um arquivo; com `range` ("bytes=0-1023"), só o trecho pedido (resposta 206). */
  async baixar(driveId: string, itemId: string, opcoes: { range?: string } = {}): Promise<Response> {
    const r = await this.get(this.url(driveId, itemId, "/content"), { redirect: "manual" });
    if (r.status < 300 || r.status >= 400) return r;
    const destino = r.headers.get("location");
    if (!destino?.startsWith("https://")) throw new GraphError("Download do SharePoint sem endereço válido", 502);
    const range = opcoes.range && /^bytes=\d*-\d*$/.test(opcoes.range) ? opcoes.range : undefined;
    const arquivo = await this.fetchImpl(destino, { signal: AbortSignal.timeout(120_000), ...(range ? { headers: { Range: range } } : {}) });
    if (!arquivo.ok) throw new GraphError(`SharePoint respondeu ${arquivo.status} no download`, arquivo.status);
    return arquivo;
  }

  /**
   * Envia um arquivo para `caminho` (pastas criadas sozinhas; substitui se existir)
   * por sessão de upload, em partes de 10 MiB. Caminho só com letras, números, ponto,
   * hífen e sublinhado em cada pasta (nada de nome de pessoa ou telefone).
   */
  async enviarArquivo(driveId: string, caminho: string, conteudo: Uint8Array): Promise<{ id: string; tamanho: number }> {
    if (!ID_SEGURO.test(driveId)) throw new GraphError("Identificador do SharePoint inválido", 400, "invalidId");
    const partes = caminho.split("/");
    if (!partes.length || partes.length > 6 || partes.some((p) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(p))) throw new GraphError("Caminho de arquivo inválido", 400, "invalidPath");
    if (!conteudo.byteLength) throw new GraphError("Arquivo vazio", 400, "emptyFile");
    const sessao = z
      .object({ uploadUrl: z.string() })
      .parse(await (await this.post(`${GRAPH}/drives/${encodeURIComponent(driveId)}/root:/${partes.join("/")}:/createUploadSession`, { item: { "@microsoft.graph.conflictBehavior": "replace" } })).json());
    const destino = new URL(sessao.uploadUrl);
    // A sessão de upload já vem autorizada: só para o próprio SharePoint, sem o token do Graph.
    if (destino.protocol !== "https:" || !/(^|\.)sharepoint\.com$/.test(destino.hostname)) throw new GraphError("Sessão de upload com endereço inesperado", 502);
    const PARTE = 32 * 320 * 1024; // múltiplo de 320 KiB, como o Graph exige
    const total = conteudo.byteLength;
    for (let inicio = 0; inicio < total; ) {
      const fim = Math.min(inicio + PARTE, total);
      let resposta: Response | null = null;
      for (let tentativa = 0; tentativa <= this.maxRetries; tentativa += 1) {
        resposta = await this.fetchImpl(destino.toString(), {
          method: "PUT",
          headers: { "Content-Range": `bytes ${inicio}-${fim - 1}/${total}` },
          body: new Uint8Array(conteudo.subarray(inicio, fim)),
          signal: AbortSignal.timeout(120_000),
        });
        if (resposta.status < 500 && resposta.status !== 429) break;
        await this.sleep(2 ** tentativa * 1000);
      }
      if (!resposta || (resposta.status !== 202 && !resposta.ok)) throw new GraphError(`SharePoint respondeu ${resposta?.status ?? 0} no upload`, resposta?.status ?? 502);
      if (fim === total) {
        const item = z.object({ id: z.string(), size: z.number() }).loose().parse(await resposta.json());
        return { id: item.id, tamanho: item.size };
      }
      inicio = fim;
    }
    throw new GraphError("Upload sem resposta final", 502);
  }

  /** Apaga sem passar pela lixeira do SharePoint. Já apagado (404) conta como apagado. */
  async apagarDefinitivo(driveId: string, itemId: string): Promise<void> {
    try {
      // Sem corpo: com `{}` o Graph responde 400 invalidRequest (conferido em 16/11/2026).
      await this.post(this.url(driveId, itemId, "/permanentDelete"), undefined);
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return;
      throw error;
    }
  }
}
