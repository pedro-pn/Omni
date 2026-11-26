import { formatarTelefone } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { lerMensagemEvolution, WhatsAppError, type EventoWhatsApp } from "@omni/integrations/whatsapp";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { getWhatsApp } from "../server/whatsapp.ts";
import type { MensagemWhatsApp } from "./conversas-fns.ts";
import { ErroParaTela } from "./erros.ts";
import { exigirModulo } from "../server/modulos.ts";

/**
 * Histórico do WhatsApp no aparelho (como o WhatsApp Web) e conversa nova.
 *
 * O histórico que o celular manda no pareamento fica na Evolution do Omni. O
 * navegador do DONO do número baixa tudo em páginas (das mais novas para as mais
 * antigas) e guarda no próprio aparelho (IndexedDB). O banco do Omni não copia as
 * mensagens antigas: só cria as conversas (nome, data e prévia da última), para
 * aparecerem na lista. Só o dono do número (app.ve_numero_whatsapp).
 */

type Mensagem = Extract<EventoWhatsApp, { tipo: "mensagem" }>;

/** Mensagem do histórico guardada no aparelho. */
export type MensagemDoAparelho = Omit<MensagemWhatsApp, "chamada" | "ensaio"> & { chatId: string; waId: string };

// Status guardados pela Evolution em cada mensagem (MessageUpdate): o mais adiantado vale.
const STATUS_EVOLUTION: Record<string, NonNullable<MensagemWhatsApp["status"]>> = { SERVER_ACK: "enviada", DELIVERY_ACK: "entregue", READ: "lida", PLAYED: "lida" };
const ORDEM_STATUS = ["enviada", "entregue", "lida"] as const;
function statusDoRegistro(registro: unknown): MensagemWhatsApp["status"] {
  const atualizacoes = (registro as { MessageUpdate?: unknown })?.MessageUpdate;
  if (!Array.isArray(atualizacoes)) return null;
  let melhor = -1;
  for (const u of atualizacoes) {
    const s = STATUS_EVOLUTION[String((u as { status?: unknown })?.status ?? "")];
    if (s && s !== "erro") melhor = Math.max(melhor, ORDEM_STATUS.indexOf(s));
  }
  return melhor >= 0 ? ORDEM_STATUS[melhor]! : null;
}

const PREVIA: Record<Mensagem["conteudo"], string> = {
  texto: "",
  imagem: "[imagem]",
  video: "[vídeo]",
  audio: "[áudio]",
  documento: "[arquivo]",
  figurinha: "[figurinha]",
  localizacao: "[localização]",
  contato: "[contato]",
  outro: "[mensagem]",
};
const previa = (m: Mensagem) => (m.texto ?? (m.conteudo === "documento" && m.arquivo ? `[arquivo] ${m.arquivo}` : PREVIA[m.conteudo])).slice(0, 160);

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  await exigirModulo(id, "whatsapp");
  return id;
}

/** O número, se for desta pessoa (RLS + app.ve_numero_whatsapp), e o cliente da Evolution. */
async function meuNumero(personId: string, numberId: string) {
  const w = getWhatsApp();
  if (!w) throw new ErroParaTela("O WhatsApp ainda não foi configurado no Omni.");
  const [n] = await withPerson(getPool(), personId, (db) =>
    db
      .select({ instancia: schema.whatsappNumbers.instanceName, status: schema.whatsappNumbers.status })
      .from(schema.whatsappNumbers)
      .where(and(eq(schema.whatsappNumbers.id, numberId), ne(schema.whatsappNumbers.status, "removido"), sql`app.ve_numero_whatsapp(${schema.whatsappNumbers.id})`)),
  );
  if (!n) throw new ErroParaTela("Este número não é seu.");
  return { ...n, whatsapp: w.whatsapp };
}

function erroDaEvolution(error: unknown): never {
  if (error instanceof WhatsAppError) throw new ErroParaTela("O WhatsApp não respondeu agora. Tente de novo em instantes.");
  throw error;
}

const POR_PAGINA = 200;

/** Uma página do histórico (200 mensagens, as mais novas primeiro) e as conversas dela criadas no Omni. */
export const paginaDoHistorico = createServerFn({ method: "POST" })
  .validator(z.object({ numberId: z.uuid(), pagina: z.number().int().min(1).max(100_000) }))
  .handler(async ({ data }): Promise<{ mensagens: MensagemDoAparelho[]; paginas: number; total: number }> => {
    const personId = await pessoa();
    const n = await meuNumero(personId, data.numberId);
    let pagina;
    try {
      pagina = await n.whatsapp.mensagens(n.instancia, {}, data.pagina, POR_PAGINA);
    } catch (error) {
      erroDaEvolution(error);
    }
    const status = new Map<string, MensagemWhatsApp["status"]>();
    const lidas = pagina.registros
      .map((r) => {
        const m = lerMensagemEvolution(n.instancia, r);
        if (m?.deMim) status.set(m.id, statusDoRegistro(r));
        return m;
      })
      .filter((m): m is Mensagem => m !== null);
    // Uma conversa por endereço; a mais recente dá a data e a prévia.
    const porConversa = new Map<string, Mensagem[]>();
    for (const m of lidas) porConversa.set(m.chatJid, [...(porConversa.get(m.chatJid) ?? []), m]);
    const ids = new Map<string, string>();
    await withPerson(getPool(), personId, async (db) => {
      for (const [jid, lista] of porConversa) {
        const ultima = lista.reduce((a, b) => (b.em > a.em ? b : a));
        const nome = ultima.grupo ? null : (lista.find((m) => !m.deMim && m.autorNome)?.autorNome ?? null);
        const lid = lista.find((m) => m.lid)?.lid ?? null;
        const [c] = (
          await db.execute<{ id: string }>(
            sql`SELECT app.whatsapp_conversa_do_dono(${data.numberId}::uuid, ${jid}, ${lid}, ${ultima.grupo}, ${ultima.telefone}, ${nome}, ${ultima.em.toISOString()}::timestamptz, ${previa(ultima)}) AS id`,
          )
        ).rows;
        ids.set(jid, c!.id);
      }
    });
    return {
      paginas: pagina.paginas,
      total: pagina.total,
      mensagens: lidas.map((m) => ({
        id: `h:${m.id}`,
        chatId: ids.get(m.chatJid)!,
        waId: m.id,
        deMim: m.deMim,
        autor: m.deMim ? null : (m.autorNome ?? formatarTelefone(m.autorJid?.match(/^(\d{8,15})@s\.whatsapp\.net$/)?.[1] ?? null)),
        autorId: m.deMim ? null : (m.autorJid ?? null),
        citada: m.citada ? { waId: m.citada.id, texto: m.citada.texto, autorId: m.citada.autorJid } : null,
        encaminhada: m.encaminhada ?? false,
        tipo: m.conteudo,
        texto: m.texto?.slice(0, 4096) ?? null,
        arquivo: m.arquivo?.slice(0, 255) ?? null,
        em: m.em.toISOString(),
        status: m.deMim ? (status.get(m.id) ?? null) : null,
      })),
    };
  });

export type ContatoWhatsApp = { jid: string; telefone: string; nome: string | null };

/** Contatos do WhatsApp do número (lidos na hora na Evolution, nada guardado no Omni). */
export const contatosDoWhatsApp = createServerFn({ method: "POST" })
  .validator(z.object({ numberId: z.uuid() }))
  .handler(async ({ data }): Promise<ContatoWhatsApp[]> => {
    const personId = await pessoa();
    const n = await meuNumero(personId, data.numberId);
    let lista;
    try {
      lista = await n.whatsapp.contatos(n.instancia);
    } catch (error) {
      erroDaEvolution(error);
    }
    // Só quem tem número (o @lid não dá para chamar sem a conversa já existir).
    const vistos = new Set<string>();
    return lista
      .filter((c) => c.jid.endsWith("@s.whatsapp.net") && !vistos.has(c.jid) && Boolean(vistos.add(c.jid)))
      .map((c) => ({ jid: c.jid, telefone: c.jid.split("@")[0]!, nome: c.nome }))
      .sort((a, b) => (a.nome ?? "~").localeCompare(b.nome ?? "~", "pt-BR") || a.telefone.localeCompare(b.telefone));
  });

/** Telefone digitado → só dígitos com DDI (sem DDI e com 10 ou 11 dígitos, é do Brasil). */
export function telefoneComDdi(digitado: string): string | null {
  const d = digitado.replace(/\D/g, "").replace(/^00/, "");
  const comDdi = d.length === 10 || d.length === 11 ? `55${d}` : d;
  return /^\d{12,15}$/.test(comDdi) ? comDdi : null;
}

/** Abre (ou acha) a conversa com um contato ou um número digitado, conferindo no WhatsApp. */
export const abrirConversaNova = createServerFn({ method: "POST" })
  .validator(z.object({ numberId: z.uuid(), telefone: z.string().trim().min(8).max(30), nome: z.string().trim().max(120).nullable().optional() }))
  .handler(async ({ data }): Promise<{ chatId: string }> => {
    const personId = await pessoa();
    const telefone = telefoneComDdi(data.telefone);
    if (!telefone) throw new ErroParaTela("Número inválido. Use o DDD e o número (ex.: 47 99999-0000) ou o DDI de outro país.");
    const n = await meuNumero(personId, data.numberId);
    if (n.status !== "conectado") throw new ErroParaTela("Conecte o seu WhatsApp antes de começar uma conversa.");
    let achado;
    try {
      [achado] = await n.whatsapp.numerosNoWhatsApp(n.instancia, [telefone]);
    } catch (error) {
      erroDaEvolution(error);
    }
    if (!achado?.existe || !achado.jid) throw new ErroParaTela(`O número ${formatarTelefone(telefone) ?? telefone} não tem WhatsApp.`);
    const jid = achado.jid;
    const [c] = await withPerson(getPool(), personId, async (db) =>
      (
        await db.execute<{ id: string }>(
          // Sem mensagens ainda: entra no topo da lista agora (a primeira mensagem confirma).
          sql`SELECT app.whatsapp_conversa_do_dono(${data.numberId}::uuid, ${jid}, NULL, false, ${jid.split("@")[0]!}, ${data.nome ?? null}, now(), NULL) AS id`,
        )
      ).rows,
    );
    return { chatId: c!.id };
  });
