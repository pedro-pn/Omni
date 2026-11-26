import { z } from "zod";

import { WhatsAppError, type ChaveDaMensagem, type ConfigWebhook, type EstadoConexao, type WhatsApp } from "./tipos.ts";

/**
 * Evolution API 2.3.7 (Baileys, pareamento por QR code) — a Evolution própria
 * do Omni (deploy/evolution), nunca a do Prisma. A chave geral só existe no
 * servidor do Omni; nunca vai para o navegador, para erros ou para log.
 * Respostas conferidas em 05/11/2026 contra a Evolution local.
 */

/** Nome da instância no provedor: gerado pelo Omni, nunca digitado. */
export const INSTANCIA_VALIDA = /^omni-[a-z0-9]{6,32}$/;

/** Eventos que o Omni recebe pelo webhook (um endereço só, sem base64 de mídia). */
export const EVENTOS_WEBHOOK = ["MESSAGES_UPSERT", "SEND_MESSAGE", "MESSAGES_UPDATE", "MESSAGES_DELETE", "MESSAGES_EDITED", "CONNECTION_UPDATE"] as const;

/**
 * Configurações de cada número: não fica "online" nem marca como lido por conta própria.
 * Pede o histórico completo no pareamento: ele fica só na Evolution e o Omni importa
 * apenas os grupos escolhidos (os demais são apagados de lá depois da importação).
 */
export const CONFIG_NUMERO = {
  rejectCall: false,
  msgCall: "",
  groupsIgnore: false,
  alwaysOnline: false,
  readMessages: false,
  readStatus: false,
  syncFullHistory: true,
} as const;

/** Cabeçalho com o segredo que o webhook do Omni confere. */
export const CABECALHO_WEBHOOK = "x-omni-webhook-key";

export type EvolutionOptions = { url: string; chave: string; fetch?: typeof fetch; timeoutMs?: number };

const ESTADOS: Record<string, EstadoConexao> = { open: "conectado", connecting: "conectando", close: "desconectado" };

/** "5547999999999@s.whatsapp.net" → "5547999999999". */
export const telefoneDoJid = (jid: string | null | undefined) => (jid ? (jid.match(/^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/)?.[1] ?? null) : null);

/** Destino aceito: número com DDI (só dígitos) ou JID de pessoa/grupo. */
const DESTINO = /^(\d{10,15}|\d{8,15}@s\.whatsapp\.net|[\d-]{6,40}@g\.us)$/;

const chaveEvolution = (c: ChaveDaMensagem) => ({ remoteJid: c.remoteJid, fromMe: c.fromMe, id: c.id, ...(c.participant ? { participant: c.participant } : {}) });

export class EvolutionClient implements WhatsApp {
  private readonly base: string;

  constructor(private readonly o: EvolutionOptions) {
    if (!o.chave || o.chave.length < 32) throw new Error("Chave da Evolution inválida");
    const u = new URL(o.url);
    if (!["http:", "https:"].includes(u.protocol)) throw new Error("Endereço da Evolution inválido");
    this.base = o.url.replace(/\/+$/, "");
  }

  private async chamar(
    metodo: "GET" | "POST" | "DELETE",
    rota: string,
    instancia: string | null,
    corpo?: unknown,
    opcoes: { consulta?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<{ status: number; dados: unknown }> {
    if (instancia !== null && !INSTANCIA_VALIDA.test(instancia)) throw new WhatsAppError("Número do WhatsApp inválido", 400, "instancia_invalida");
    const url = `${this.base}/${rota}${instancia ? `/${instancia}` : ""}${opcoes.consulta ? `?${new URLSearchParams(opcoes.consulta)}` : ""}`;
    let r: Response;
    try {
      r = await (this.o.fetch ?? fetch)(url, {
        method: metodo,
        headers: { apikey: this.o.chave, ...(corpo ? { "Content-Type": "application/json" } : {}) },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(opcoes.timeoutMs ?? this.o.timeoutMs ?? 15_000),
        redirect: "error",
      });
    } catch {
      throw new WhatsAppError("Evolution fora do ar", 503, "indisponivel");
    }
    const texto = await r.text();
    let dados: unknown = null;
    try {
      dados = texto ? JSON.parse(texto) : null;
    } catch {
      dados = null;
    }
    return { status: r.status, dados };
  }

  private falha(rota: string, status: number): never {
    throw new WhatsAppError(`Evolution respondeu ${status} em ${rota}`, status, status === 401 ? "chave_recusada" : status === 404 ? "inexistente" : undefined);
  }

  async criarNumero(instancia: string, webhook: ConfigWebhook): Promise<void> {
    const r = await this.chamar("POST", "instance/create", null, { instanceName: instancia, integration: "WHATSAPP-BAILEYS", qrcode: false, ...CONFIG_NUMERO });
    // 403 = já existe (recriar depois de uma falha no meio): segue para configurar.
    if (r.status !== 201 && r.status !== 200 && r.status !== 403) this.falha("instance/create", r.status);
    await this.configurarNumero(instancia, webhook);
  }

  async configurarNumero(instancia: string, webhook: ConfigWebhook): Promise<void> {
    if (!webhook.segredo || webhook.segredo.length < 32) throw new WhatsAppError("Segredo do webhook inválido", 400);
    const s = await this.chamar("POST", "settings/set", instancia, CONFIG_NUMERO);
    if (s.status < 200 || s.status >= 300) this.falha("settings/set", s.status);
    const w = await this.chamar("POST", "webhook/set", instancia, {
      webhook: { enabled: true, url: webhook.url, headers: { [CABECALHO_WEBHOOK]: webhook.segredo }, byEvents: false, base64: false, events: [...EVENTOS_WEBHOOK] },
    });
    if (w.status < 200 || w.status >= 300) this.falha("webhook/set", w.status);
    // Confere o que ficou gravado (a Evolution não tem escrita condicional).
    const f = await this.chamar("GET", "webhook/find", instancia);
    const gravado = z
      .object({ enabled: z.boolean(), url: z.string().nullable(), events: z.array(z.string()), webhookBase64: z.boolean(), headers: z.record(z.string(), z.unknown()).nullable().optional() })
      .safeParse(f.dados);
    if (
      !gravado.success ||
      !gravado.data.enabled ||
      gravado.data.url !== webhook.url ||
      gravado.data.webhookBase64 ||
      gravado.data.headers?.[CABECALHO_WEBHOOK] !== webhook.segredo ||
      !EVENTOS_WEBHOOK.every((e) => gravado.data.events.includes(e))
    ) {
      throw new WhatsAppError("Webhook não ficou configurado na Evolution", 502, "webhook_divergente");
    }
  }

  async qrCode(instancia: string) {
    const r = await this.chamar("GET", "instance/connect", instancia);
    if (r.status === 404) return { imagem: null, codigoPareamento: null, estado: "inexistente" as const };
    if (r.status !== 200) this.falha("instance/connect", r.status);
    const qr = z.object({ base64: z.string().optional(), pairingCode: z.string().nullable().optional() }).safeParse(r.dados);
    const imagem = qr.success && qr.data.base64?.startsWith("data:image/png;base64,") ? qr.data.base64 : null;
    if (imagem) return { imagem, codigoPareamento: qr.data?.pairingCode ?? null, estado: "conectando" as const };
    // Já conectado: a Evolution devolve o estado em vez do QR.
    return { imagem: null, codigoPareamento: null, estado: (await this.estado(instancia)).estado };
  }

  async estado(instancia: string) {
    const r = await this.chamar("GET", "instance/fetchInstances", null);
    if (r.status !== 200) this.falha("instance/fetchInstances", r.status);
    const lista = z
      .array(z.object({ name: z.string(), connectionStatus: z.string().nullable().optional(), ownerJid: z.string().nullable().optional(), profileName: z.string().nullable().optional() }).loose())
      .safeParse(r.dados);
    if (!lista.success) throw new WhatsAppError("Resposta inesperada da Evolution", 502);
    const i = lista.data.find((x) => x.name === instancia);
    if (!i) return { estado: "inexistente" as const, telefone: null, nomePerfil: null };
    return { estado: ESTADOS[i.connectionStatus ?? ""] ?? ("desconectado" as const), telefone: telefoneDoJid(i.ownerJid), nomePerfil: i.profileName ?? null };
  }

  async desconectar(instancia: string): Promise<void> {
    const r = await this.chamar("DELETE", "instance/logout", instancia);
    // 400/404: já estava desconectado.
    if (r.status !== 200 && r.status !== 400 && r.status !== 404) this.falha("instance/logout", r.status);
  }

  async remover(instancia: string): Promise<void> {
    const r = await this.chamar("DELETE", "instance/delete", instancia);
    if (r.status !== 200 && r.status !== 404) this.falha("instance/delete", r.status);
  }

  async enviarArquivo(instancia: string, para: string, arquivo: { conteudo: Buffer; mimetype: string; nome: string; legenda?: string }) {
    if (!DESTINO.test(para)) throw new WhatsAppError("Destino inválido", 400, "destino_invalido");
    if (!arquivo.conteudo.length || arquivo.conteudo.length > 16 * 1024 * 1024) throw new WhatsAppError("Arquivo vazio ou grande demais", 400, "arquivo_invalido");
    const tipo = arquivo.mimetype.split("/")[0];
    const mediatype = tipo === "image" ? "image" : tipo === "video" ? "video" : tipo === "audio" ? "audio" : "document";
    const r = await this.chamar(
      "POST",
      "message/sendMedia",
      instancia,
      {
        number: para,
        mediatype,
        mimetype: arquivo.mimetype,
        caption: arquivo.legenda ?? "",
        media: arquivo.conteudo.toString("base64"),
        fileName: arquivo.nome,
        delay: 0,
      },
      { timeoutMs: 120_000 },
    );
    if (r.status !== 200 && r.status !== 201) this.falha("message/sendMedia", r.status);
    const k = z.object({ key: z.object({ id: z.string(), remoteJid: z.string() }) }).safeParse(r.dados);
    if (!k.success) throw new WhatsAppError("Resposta inesperada da Evolution", 502);
    return { id: k.data.key.id, jid: k.data.key.remoteJid };
  }

  async enviarAudio(instancia: string, para: string, audio: Buffer) {
    if (!DESTINO.test(para)) throw new WhatsAppError("Destino inválido", 400, "destino_invalido");
    if (!audio.length || audio.length > 16 * 1024 * 1024) throw new WhatsAppError("Áudio vazio ou grande demais", 400, "arquivo_invalido");
    // encoding: a Evolution passa pelo ffmpeg e manda como mensagem de voz (ptt, audio/ogg; codecs=opus).
    const r = await this.chamar("POST", "message/sendWhatsAppAudio", instancia, { number: para, audio: audio.toString("base64"), encoding: true, delay: 0 }, { timeoutMs: 120_000 });
    if (r.status !== 200 && r.status !== 201) this.falha("message/sendWhatsAppAudio", r.status);
    const k = z.object({ key: z.object({ id: z.string(), remoteJid: z.string() }) }).safeParse(r.dados);
    if (!k.success) throw new WhatsAppError("Resposta inesperada da Evolution", 502);
    return { id: k.data.key.id, jid: k.data.key.remoteJid };
  }

  async conversas(instancia: string) {
    const r = await this.chamar("POST", "chat/findChats", instancia, {});
    if (r.status !== 200) this.falha("chat/findChats", r.status);
    const lista = z
      .array(
        z
          .object({
            remoteJid: z.string(),
            name: z.string().nullable().optional(),
            pushName: z.string().nullable().optional(),
            profilePicUrl: z.string().nullable().optional(),
            lastMessage: z.object({ messageTimestamp: z.union([z.number(), z.string()]).optional() }).loose().nullable().optional(),
          })
          .loose(),
      )
      .safeParse(r.dados);
    if (!lista.success) throw new WhatsAppError("Resposta inesperada da Evolution", 502);
    const vistos = new Set<string>();
    return lista.data
      .filter((c) => /^([\d-]{6,40}@g\.us|\d{5,20}@(s\.whatsapp\.net|lid))$/.test(c.remoteJid) && !vistos.has(c.remoteJid) && Boolean(vistos.add(c.remoteJid)))
      .map((c) => {
        const ts = Number(c.lastMessage?.messageTimestamp);
        return {
          jid: c.remoteJid,
          grupo: c.remoteJid.endsWith("@g.us"),
          nome: (c.name ?? c.pushName)?.trim() || null,
          foto: c.profilePicUrl && /^https:\/\/([a-z0-9-]+\.)*whatsapp\.net\//.test(c.profilePicUrl) ? c.profilePicUrl : null,
          ultimaEm: Number.isFinite(ts) && ts > 1_000_000_000 ? new Date(ts * 1000) : null,
        };
      });
  }

  async contatos(instancia: string) {
    const r = await this.chamar("POST", "chat/findContacts", instancia, {});
    if (r.status !== 200) this.falha("chat/findContacts", r.status);
    const lista = z
      .array(
        z
          .object({
            remoteJid: z.string(),
            pushName: z.string().nullable().optional(),
            profilePicUrl: z.string().nullable().optional(),
            // Patch do Omni na Evolution (patch-lid): o outro identificador da mesma pessoa.
            lidJid: z.string().nullable().optional(),
            pnJid: z.string().nullable().optional(),
          })
          .loose(),
      )
      .safeParse(r.dados);
    if (!lista.success) throw new WhatsAppError("Resposta inesperada da Evolution", 502);
    return lista.data
      .filter((c) => /^\d{5,20}@(s\.whatsapp\.net|lid)$/.test(c.remoteJid))
      .map((c) => {
        const nome = c.pushName?.trim() || null;
        // A Evolution põe o próprio número quando não sabe o nome: isso não é nome.
        const soNumero = nome !== null && nome.replace(/\D/g, "") === c.remoteJid.split("@")[0];
        const pelo = c.remoteJid.endsWith("@lid") ? c.pnJid : c.lidJid;
        const outro = pelo && /^\d{5,20}@(s\.whatsapp\.net|lid)$/.test(pelo) && pelo.endsWith("@lid") !== c.remoteJid.endsWith("@lid") ? pelo : null;
        return {
          jid: c.remoteJid,
          nome: soNumero || (nome !== null && /^[\d\s+().-]+$/.test(nome)) ? null : nome,
          foto: c.profilePicUrl && /^https:\/\/([a-z0-9-]+\.)*whatsapp\.net\//.test(c.profilePicUrl) ? c.profilePicUrl : null,
          outro,
        };
      });
  }

  async numerosNoWhatsApp(instancia: string, numeros: string[]) {
    const lista = numeros.filter((n) => /^\d{8,15}$/.test(n)).slice(0, 20);
    if (!lista.length) return [];
    const r = await this.chamar("POST", "chat/whatsappNumbers", instancia, { numbers: lista }, { timeoutMs: 15_000 });
    if (r.status !== 200 && r.status !== 201) this.falha("chat/whatsappNumbers", r.status);
    const itens = z
      .array(z.object({ exists: z.boolean(), jid: z.string().nullable().optional(), number: z.union([z.string(), z.number()]).nullable().optional() }).loose())
      .safeParse(r.dados);
    if (!itens.success) throw new WhatsAppError("Resposta inesperada da Evolution", 502);
    return itens.data.map((i, k) => {
      const jid = i.jid && /^\d{8,20}@s\.whatsapp\.net$/.test(i.jid) ? i.jid : null;
      return { numero: String(i.number ?? lista[k] ?? "").replace(/\D/g, ""), existe: i.exists && jid !== null, jid };
    });
  }

  async reagir(instancia: string, chave: ChaveDaMensagem, emoji: string): Promise<void> {
    if (emoji.length > 16) throw new WhatsAppError("Reação inválida", 400, "reacao_invalida");
    const r = await this.chamar("POST", "message/sendReaction", instancia, { key: chaveEvolution(chave), reaction: emoji });
    if (r.status >= 400) this.falha("message/sendReaction", r.status);
  }

  async apagarParaTodos(instancia: string, chave: ChaveDaMensagem): Promise<void> {
    const r = await this.chamar("DELETE", "chat/deleteMessageForEveryone", instancia, chaveEvolution(chave));
    if (r.status >= 400) this.falha("chat/deleteMessageForEveryone", r.status);
  }

  async editar(instancia: string, chave: ChaveDaMensagem, texto: string): Promise<void> {
    if (!texto.trim() || texto.length > 4096) throw new WhatsAppError("Mensagem vazia ou longa demais", 400, "texto_invalido");
    const r = await this.chamar("POST", "chat/updateMessage", instancia, { number: chave.remoteJid, key: chaveEvolution(chave), text: texto });
    if (r.status >= 400) this.falha("chat/updateMessage", r.status);
  }

  async fotoDoPerfil(instancia: string, jid: string): Promise<string | null> {
    const r = await this.chamar("POST", "chat/fetchProfilePictureUrl", instancia, { number: jid }, { timeoutMs: 8_000 });
    if (r.status >= 400) return null;
    const url = (r.dados as { profilePictureUrl?: unknown } | null)?.profilePictureUrl;
    return typeof url === "string" && url ? url : null;
  }

  async infoGrupo(instancia: string, jid: string) {
    if (!/^[\d-]{6,40}@g\.us$/.test(jid)) throw new WhatsAppError("Grupo inválido", 400, "destino_invalido");
    let r;
    try {
      r = await this.chamar("GET", "group/findGroupInfos", instancia, undefined, { consulta: { groupJid: jid }, timeoutMs: 8_000 });
    } catch {
      return null; // a Evolution consulta o WhatsApp: pode demorar; o nome fica para depois
    }
    if (r.status !== 200) return null;
    const g = z.object({ subject: z.string().nullable().optional(), size: z.number().nullable().optional() }).loose().safeParse(r.dados);
    return g.success ? { nome: g.data.subject?.trim() || null, participantes: g.data.size ?? null } : null;
  }

  async mensagens(instancia: string, filtro: { jid?: string; desde?: Date }, pagina: number, porPagina = 100) {
    const where: Record<string, unknown> = {};
    if (filtro.jid) where.key = { remoteJid: filtro.jid };
    if (filtro.desde) where.messageTimestamp = { gte: Math.floor(filtro.desde.getTime() / 1000) };
    const r = await this.chamar("POST", "chat/findMessages", instancia, { where, page: pagina, offset: Math.min(Math.max(porPagina, 1), 200) });
    if (r.status !== 200) this.falha("chat/findMessages", r.status);
    const m = z
      .object({ messages: z.object({ total: z.number(), pages: z.number(), records: z.array(z.unknown()) }) })
      .safeParse(r.dados);
    if (!m.success) throw new WhatsAppError("Resposta inesperada da Evolution", 502);
    return { registros: m.data.messages.records, paginas: m.data.messages.pages, total: m.data.messages.total };
  }

  async midia(instancia: string, waId: string) {
    if (!/^[A-Za-z0-9]{6,128}$/.test(waId)) throw new WhatsAppError("Mensagem inválida", 400);
    const r = await this.chamar("POST", "chat/getBase64FromMediaMessage", instancia, { message: { key: { id: waId } }, convertToMp4: false }, { timeoutMs: 60_000 });
    if (r.status === 400 || r.status === 404) throw new WhatsAppError("Arquivo não encontrado", 404, "inexistente");
    if (r.status !== 200 && r.status !== 201) this.falha("chat/getBase64FromMediaMessage", r.status);
    const m = z.object({ base64: z.string().min(1), mimetype: z.string(), fileName: z.string().nullable().optional() }).loose().safeParse(r.dados);
    if (!m.success) throw new WhatsAppError("Resposta inesperada da Evolution", 502);
    return { conteudo: Buffer.from(m.data.base64, "base64"), mimetype: m.data.mimetype.split(";")[0]!.trim().toLowerCase(), nome: m.data.fileName ?? null };
  }

  async enviarTexto(instancia: string, para: string, texto: string, opcoes: { citada?: ChaveDaMensagem & { texto?: string | null } } = {}) {
    if (!DESTINO.test(para)) throw new WhatsAppError("Destino inválido", 400, "destino_invalido");
    if (!texto.trim() || texto.length > 4096) throw new WhatsAppError("Mensagem vazia ou longa demais", 400, "texto_invalido");
    const citada = opcoes.citada
      ? { quoted: { key: { remoteJid: opcoes.citada.remoteJid, fromMe: opcoes.citada.fromMe, id: opcoes.citada.id, ...(opcoes.citada.participant ? { participant: opcoes.citada.participant } : {}) }, message: { conversation: opcoes.citada.texto ?? "" } } }
      : {};
    // A prévia dos links fica com o WhatsApp de quem recebe (como no celular).
    const r = await this.chamar("POST", "message/sendText", instancia, { number: para, text: texto, delay: 0, linkPreview: true, ...citada });
    if (r.status !== 200 && r.status !== 201) this.falha("message/sendText", r.status);
    const k = z.object({ key: z.object({ id: z.string(), remoteJid: z.string() }) }).safeParse(r.dados);
    if (!k.success) throw new WhatsAppError("Resposta inesperada da Evolution", 502);
    return { id: k.data.key.id, jid: k.data.key.remoteJid };
  }
}
