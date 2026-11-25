import { z } from "zod";

import { INSTANCIA_VALIDA, telefoneDoJid } from "./evolution.ts";

/**
 * Eventos do webhook da Evolution → eventos do Omni. Só o necessário: chaves,
 * URLs de mídia, base64, miniaturas e o `apikey` que a Evolution põe no corpo
 * nunca saem daqui. Status (stories), canais, reações e mensagens de protocolo
 * são ignorados.
 */

export type TipoMensagemWhatsApp = "texto" | "imagem" | "video" | "audio" | "documento" | "figurinha" | "localizacao" | "contato" | "outro";
export type StatusMensagemWhatsApp = "enviada" | "entregue" | "lida" | "erro";

export type EventoWhatsApp =
  | {
      tipo: "mensagem";
      instancia: string;
      /** Conversa: pessoa (pelo número, …@s.whatsapp.net, quando ele vem; senão …@lid) ou grupo (…@g.us). */
      chatJid: string;
      /** Id de privacidade da pessoa (…@lid), quando veio junto: liga as mensagens que chegam só com ele. */
      lid: string | null;
      grupo: boolean;
      /** Telefone da conversa com pessoa, quando o JID traz o número. */
      telefone: string | null;
      id: string;
      deMim: boolean;
      autorJid: string | null;
      autorNome: string | null;
      conteudo: TipoMensagemWhatsApp;
      texto: string | null;
      arquivo: string | null;
      em: Date;
    }
  | { tipo: "status"; instancia: string; chatJid: string; id: string; status: StatusMensagemWhatsApp }
  | { tipo: "conexao"; instancia: string; estado: "conectado" | "conectando" | "desconectado"; telefone: string | null; nomePerfil: string | null };

const JID_PESSOA = /^\d{5,20}(?::\d+)?@(s\.whatsapp\.net|lid)$/;
const JID_GRUPO = /^[\d-]{6,40}@g\.us$/;

const chaveSchema = z
  .object({
    remoteJid: z.string(),
    fromMe: z.boolean(),
    id: z.string().min(1).max(128),
    participant: z.string().nullable().optional(),
    // Evolution 2.3: o número real quando o JID vem como …@lid.
    remoteJidAlt: z.string().nullable().optional(),
    participantAlt: z.string().nullable().optional(),
    senderPn: z.string().nullable().optional(),
  })
  .loose();

const mensagemSchema = z
  .object({
    key: chaveSchema,
    pushName: z.string().nullable().optional(),
    message: z.record(z.string(), z.unknown()).nullable().optional(),
    messageTimestamp: z.union([z.number(), z.string()]).optional(),
  })
  .loose();

const s = (v: unknown, max = 4096) => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
const o = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Tira os invólucros (temporária, visualização única, documento com legenda, edição). */
function desembrulhar(m: Record<string, unknown>): Record<string, unknown> {
  for (let i = 0; i < 4; i += 1) {
    const dentro =
      o(m.ephemeralMessage).message ??
      o(m.viewOnceMessage).message ??
      o(m.viewOnceMessageV2).message ??
      o(m.documentWithCaptionMessage).message;
    if (!dentro || typeof dentro !== "object") break;
    m = dentro as Record<string, unknown>;
  }
  return m;
}

/** Conteúdo da mensagem; null para o que o Omni ignora (reação, protocolo, enquete…). */
export function conteudoDaMensagem(bruta: Record<string, unknown>): { conteudo: TipoMensagemWhatsApp; texto: string | null; arquivo: string | null } | null {
  const m = desembrulhar(bruta);
  if ("conversation" in m) return { conteudo: "texto", texto: s(m.conversation), arquivo: null };
  if ("extendedTextMessage" in m) return { conteudo: "texto", texto: s(o(m.extendedTextMessage).text), arquivo: null };
  if ("imageMessage" in m) return { conteudo: "imagem", texto: s(o(m.imageMessage).caption), arquivo: null };
  if ("videoMessage" in m) return { conteudo: "video", texto: s(o(m.videoMessage).caption), arquivo: null };
  if ("audioMessage" in m) return { conteudo: "audio", texto: null, arquivo: null };
  if ("documentMessage" in m) {
    const d = o(m.documentMessage);
    return { conteudo: "documento", texto: s(d.caption), arquivo: s(d.fileName, 255) ?? s(d.title, 255) };
  }
  if ("stickerMessage" in m) return { conteudo: "figurinha", texto: null, arquivo: null };
  if ("locationMessage" in m || "liveLocationMessage" in m) return { conteudo: "localizacao", texto: s(o(m.locationMessage).name ?? o(m.locationMessage).address), arquivo: null };
  if ("contactMessage" in m || "contactsArrayMessage" in m) return { conteudo: "contato", texto: s(o(m.contactMessage).displayName), arquivo: null };
  const ignorados = ["reactionMessage", "protocolMessage", "senderKeyDistributionMessage", "pollUpdateMessage", "messageContextInfo", "editedMessage", "keepInChatMessage", "pinInChatMessage"];
  const chaves = Object.keys(m).filter((k) => k !== "messageContextInfo");
  if (!chaves.length || chaves.every((k) => ignorados.includes(k))) return null;
  return { conteudo: "outro", texto: null, arquivo: null };
}

const pessoaValida = (jid: string | null | undefined) => (jid && JID_PESSOA.test(jid) ? jid : null);
/** JID sem o sufixo do aparelho (…:12@…). */
const semAparelho = (jid: string) => jid.replace(/:\d+@/, "@");

/** Conversa com pessoa: o JID pelo número quando a Evolution manda (remoteJid ou remoteJidAlt), e o @lid à parte. */
export function jidsDaPessoa(...candidatos: Array<string | null | undefined>): { jid: string | null; lid: string | null } {
  const validos = candidatos.map(pessoaValida).filter((j): j is string => j !== null).map(semAparelho);
  const numero = validos.find((j) => j.endsWith("@s.whatsapp.net")) ?? null;
  const lid = validos.find((j) => j.endsWith("@lid")) ?? null;
  return { jid: numero ?? lid, lid };
}

/** Uma mensagem no formato da Evolution (webhook ou chat/findMessages) → evento do Omni; null se não interessa. */
export function lerMensagemEvolution(instancia: string, dados: unknown): Extract<EventoWhatsApp, { tipo: "mensagem" }> | null {
  return mensagem(instancia, dados);
}

function mensagem(instancia: string, dados: unknown): Extract<EventoWhatsApp, { tipo: "mensagem" }> | null {
  const p = mensagemSchema.safeParse(dados);
  if (!p.success || !p.data.message) return null;
  const k = p.data.key;
  const grupo = JID_GRUPO.test(k.remoteJid);
  if (!grupo && !JID_PESSOA.test(k.remoteJid)) return null; // status@broadcast, canais, etc.
  const c = conteudoDaMensagem(p.data.message);
  if (!c) return null;
  const ts = Number(p.data.messageTimestamp);
  const em = Number.isFinite(ts) && ts > 1_000_000_000 ? new Date(ts * 1000) : new Date();
  // Em grupo, o autor é o participante; em conversa com pessoa, a própria pessoa (ou eu).
  const pessoa = grupo ? null : jidsDaPessoa(k.remoteJid, k.remoteJidAlt, k.senderPn);
  const autorJid = k.fromMe ? null : grupo ? (pessoaValida(k.participantAlt) ?? pessoaValida(k.participant)) : (pessoa?.jid ?? k.remoteJid);
  return {
    tipo: "mensagem",
    instancia,
    chatJid: pessoa?.jid ?? k.remoteJid,
    lid: pessoa?.lid ?? null,
    grupo,
    telefone: grupo ? null : (telefoneDoJid(k.remoteJid) ?? telefoneDoJid(k.remoteJidAlt) ?? telefoneDoJid(k.senderPn)),
    id: k.id,
    deMim: k.fromMe,
    autorJid,
    autorNome: k.fromMe ? null : s(p.data.pushName, 120),
    ...c,
    em,
  };
}

const STATUS: Record<string, StatusMensagemWhatsApp> = { SERVER_ACK: "enviada", DELIVERY_ACK: "entregue", READ: "lida", PLAYED: "lida", ERROR: "erro" };

/** Corpo do webhook → eventos do Omni (lista vazia para o que não interessa). */
export function lerEventoWebhook(corpo: unknown): EventoWhatsApp[] {
  const p = z.object({ event: z.string(), instance: z.string(), data: z.unknown() }).safeParse(corpo);
  if (!p.success || !INSTANCIA_VALIDA.test(p.data.instance)) return [];
  const evento = p.data.event.toLowerCase().replaceAll("_", ".");
  const instancia = p.data.instance;
  const lista = Array.isArray(p.data.data) ? p.data.data : [p.data.data];

  if (evento === "messages.upsert" || evento === "send.message") {
    return lista.map((d) => mensagem(instancia, d)).filter((e): e is NonNullable<typeof e> => e !== null);
  }
  if (evento === "messages.update") {
    return lista.flatMap((d) => {
      const u = z
        .object({ keyId: z.string().optional(), messageId: z.string().optional(), remoteJid: z.string(), status: z.string(), key: z.object({ id: z.string() }).loose().optional() })
        .loose()
        .safeParse(d);
      const id = u.success ? (u.data.keyId ?? u.data.key?.id ?? null) : null;
      const status = u.success ? STATUS[u.data.status] : undefined;
      return u.success && id && status ? [{ tipo: "status" as const, instancia, chatJid: u.data.remoteJid, id, status }] : [];
    });
  }
  if (evento === "connection.update") {
    const c = z.object({ state: z.string(), wuid: z.string().nullable().optional(), profileName: z.string().nullable().optional() }).loose().safeParse(lista[0]);
    const estado = c.success ? ({ open: "conectado", connecting: "conectando", close: "desconectado" } as const)[c.data.state as "open"] : undefined;
    return c.success && estado ? [{ tipo: "conexao", instancia, estado, telefone: telefoneDoJid(c.data.wuid), nomePerfil: s(c.data.profileName, 120) }] : [];
  }
  return [];
}
