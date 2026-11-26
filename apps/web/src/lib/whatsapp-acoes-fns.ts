import { schema, withPerson, type Db } from "@omni/db";
import { WhatsAppError } from "@omni/integrations/whatsapp";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { getEnv } from "../server/env.ts";
import { exigirModulo } from "../server/modulos.ts";
import { personIdFromRequest } from "../server/session.ts";
import { getPonteDeAcoes, getWhatsApp } from "../server/whatsapp.ts";
import { enviarPeloWhatsApp, MAX_ARQUIVO, TIPOS_ARQUIVO } from "../server/whatsapp-envio.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Ações nas mensagens do WhatsApp, como no WhatsApp Web (0087): reagir, apagar (para mim e para
 * todos), editar, encaminhar, favoritar e fixar (mensagem e conversa). O que vai ao WhatsApp
 * segue WHATSAPP_ENVIO: ensaio aplica só no Omni (para testar a tela), real faz no WhatsApp e já
 * mostra no Omni (o webhook confirma depois, sem repetir). Favoritar, apagar para mim e fixar
 * conversa são só da pessoa.
 */

const mensagemSchema = z.object({
  chatId: z.uuid(),
  waId: z.string().min(1).max(128),
  deMim: z.boolean(),
  /** Grupo: quem escreveu (JID), para o WhatsApp achar a mensagem. */
  autorId: z.string().max(200).nullable().optional(),
});
type Mensagem = z.infer<typeof mensagemSchema>;

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  await exigirModulo(id, "whatsapp");
  return id;
}

/** A conversa vista pela pessoa (RLS) e se ela responde por este número. */
async function conversa(db: Db, personId: string, chatId: string) {
  const [c] = await db
    .select({
      jid: schema.whatsappChats.jid,
      lid: schema.whatsappChats.lid,
      grupo: schema.whatsappChats.isGroup,
      instancia: schema.whatsappNumbers.instanceName,
      dono: schema.whatsappNumbers.ownerPersonId,
      linha: schema.whatsappNumbers.phone,
      conectado: sql<boolean>`${schema.whatsappNumbers.status} = 'conectado'`,
    })
    .from(schema.whatsappChats)
    .innerJoin(schema.whatsappNumbers, eq(schema.whatsappNumbers.id, schema.whatsappChats.numberId))
    .where(eq(schema.whatsappChats.id, chatId));
  if (!c) throw new ErroParaTela("Conversa não encontrada.");
  return { ...c, responde: c.dono === personId };
}

/** Faz no WhatsApp (modo real) — em ensaio não sai nada; desligado recusa. */
async function noWhatsApp(c: { conectado: boolean }, fazer: (w: NonNullable<ReturnType<typeof getWhatsApp>>["whatsapp"]) => Promise<void>): Promise<"ensaio" | "real"> {
  const modo = getEnv().WHATSAPP_ENVIO;
  if (modo === "desligado") throw new ErroParaTela("O envio pelo WhatsApp está desligado neste ambiente.");
  if (modo === "ensaio") return "ensaio";
  const w = getWhatsApp();
  if (!w || !c.conectado) throw new ErroParaTela("O WhatsApp deste número não está conectado.");
  try {
    await fazer(w.whatsapp);
  } catch (error) {
    if (error instanceof WhatsAppError) throw new ErroParaTela("O WhatsApp não aceitou agora. Tente de novo.");
    throw error;
  }
  return "real";
}

/**
 * Leva ao celular o que hoje fica no Omni (fixar, favoritar), pela ponte de ações: só com o envio
 * real, a ponte ligada e o dono do número. Se o celular não aceitar, fica no Omni (sem erro).
 */
async function noCelular(
  personId: string,
  chatId: string,
  fazer: (ponte: NonNullable<ReturnType<typeof getPonteDeAcoes>>, linha: string, c: Awaited<ReturnType<typeof conversa>>) => Promise<void>,
): Promise<boolean> {
  const ponte = getPonteDeAcoes();
  if (getEnv().WHATSAPP_ENVIO !== "real" || !ponte) return false;
  const c = await withPerson(getPool(), personId, (db) => conversa(db, personId, chatId));
  if (!c.responde || !c.conectado || !c.linha) return false;
  try {
    await fazer(ponte, c.linha, c);
    return true;
  } catch (error) {
    console.error("[whatsapp] ação não chegou ao celular:", (error as { code?: string }).code ?? (error as Error).name);
    return false;
  }
}

const chave = (c: { jid: string; grupo: boolean }, m: Mensagem) => ({ remoteJid: c.jid, fromMe: m.deMim, id: m.waId, participant: c.grupo && !m.deMim ? (m.autorId ?? null) : null });

// ---------------------------------------------------------------- no WhatsApp

export const reagirMensagem = createServerFn({ method: "POST" })
  .validator(mensagemSchema.extend({ emoji: z.string().max(16) }))
  .handler(async ({ data }): Promise<{ modo: "ensaio" | "real" }> => {
    const personId = await pessoa();
    const c = await withPerson(getPool(), personId, (db) => conversa(db, personId, data.chatId));
    if (!c.responde) throw new ErroParaTela("Só quem responde por este número reage.");
    const modo = await noWhatsApp(c, (w) => w.reagir(c.instancia, chave(c, data), data.emoji));
    await getPool().query("SELECT app.whatsapp_registrar_reacao($1, $2, $3, $4, true, NULL, NULL, $5, now())", [c.instancia, c.jid, c.lid, data.waId, data.emoji]);
    return { modo };
  });

export const apagarMensagem = createServerFn({ method: "POST" })
  .validator(mensagemSchema.extend({ paraTodos: z.boolean(), em: z.iso.datetime().optional() }))
  .handler(async ({ data }): Promise<{ modo: "ensaio" | "real" | "so-para-mim" }> => {
    const personId = await pessoa();
    if (!data.paraTodos) {
      await withPerson(getPool(), personId, (db) =>
        db
          .insert(schema.whatsappMessageFlags)
          .values({ personId, chatId: data.chatId, waId: data.waId, hidden: true })
          .onConflictDoUpdate({ target: [schema.whatsappMessageFlags.personId, schema.whatsappMessageFlags.chatId, schema.whatsappMessageFlags.waId], set: { hidden: true, updatedAt: new Date() } }),
      );
      return { modo: "so-para-mim" };
    }
    const c = await withPerson(getPool(), personId, (db) => conversa(db, personId, data.chatId));
    if (!c.responde || !data.deMim) throw new ErroParaTela("Só dá para apagar para todos uma mensagem sua.");
    // O WhatsApp só deixa apagar para todos por cerca de 2 dias.
    if (data.em && Date.now() - Date.parse(data.em) > 2 * 24 * 3600_000) throw new ErroParaTela("Passou o prazo do WhatsApp para apagar para todos. Apague só para você.");
    const modo = await noWhatsApp(c, (w) => w.apagarParaTodos(c.instancia, chave(c, data)));
    await getPool().query("SELECT app.whatsapp_registrar_apagada($1, $2, $3, $4)", [c.instancia, c.jid, c.lid, data.waId]);
    return { modo };
  });

export const editarMensagem = createServerFn({ method: "POST" })
  .validator(mensagemSchema.extend({ texto: z.string().trim().min(1, "Escreva a mensagem.").max(4096), em: z.iso.datetime().optional() }))
  .handler(async ({ data }): Promise<{ modo: "ensaio" | "real" }> => {
    const personId = await pessoa();
    const c = await withPerson(getPool(), personId, (db) => conversa(db, personId, data.chatId));
    if (!c.responde || !data.deMim) throw new ErroParaTela("Só dá para editar uma mensagem sua.");
    // Como no WhatsApp: só nos primeiros 15 minutos.
    if (data.em && Date.now() - Date.parse(data.em) > 15 * 60_000) throw new ErroParaTela("O WhatsApp só deixa editar nos primeiros 15 minutos.");
    const modo = await noWhatsApp(c, (w) => w.editar(c.instancia, chave(c, data), data.texto));
    await getPool().query("SELECT app.whatsapp_registrar_edicao($1, $2, $3, $4, $5, now())", [c.instancia, c.jid, c.lid, data.waId, data.texto]);
    return { modo };
  });

/** Encaminhar até 10 mensagens para até 5 conversas (texto; foto, vídeo, áudio e arquivo vão como arquivo). */
export const encaminharMensagens = createServerFn({ method: "POST" })
  .validator(
    z.object({
      deChatId: z.uuid(),
      mensagens: z.array(z.object({ waId: z.string().min(1).max(128), tipo: z.string().max(20), texto: z.string().max(4096).nullable(), arquivo: z.string().max(255).nullable() })).min(1).max(10),
      paraChatIds: z.array(z.uuid()).min(1).max(5),
    }),
  )
  .handler(async ({ data }): Promise<{ enviadas: number; modo: "ensaio" | "real" }> => {
    const personId = await pessoa();
    const origem = await withPerson(getPool(), personId, (db) => conversa(db, personId, data.deChatId));
    let enviadas = 0;
    let modo: "ensaio" | "real" = "ensaio";
    for (const para of data.paraChatIds) {
      for (const m of data.mensagens) {
        let arquivo: Parameters<typeof enviarPeloWhatsApp>[3];
        if (m.tipo !== "texto") {
          const w = getWhatsApp();
          const midia = w && getEnv().WHATSAPP_ENVIO === "real" ? await w.whatsapp.midia(origem.instancia, m.waId).catch(() => null) : null;
          if (midia && TIPOS_ARQUIVO.test(midia.mimetype) && midia.conteudo.length <= MAX_ARQUIVO) {
            arquivo = { conteudo: midia.conteudo, mimetype: midia.mimetype, nome: m.arquivo ?? midia.nome ?? "arquivo" };
          } else if (getEnv().WHATSAPP_ENVIO === "real") {
            throw new ErroParaTela("Não foi possível encaminhar um dos arquivos (tipo não aceito ou indisponível).");
          }
        }
        const texto = m.texto ?? (arquivo ? "" : `[${m.arquivo ?? m.tipo}]`);
        const r = await enviarPeloWhatsApp(personId, para, texto, arquivo);
        modo = r.modo;
        enviadas += 1;
      }
    }
    return { enviadas, modo };
  });

// ---------------------------------------------------------------- no Omni

export const favoritarMensagem = createServerFn({ method: "POST" })
  .validator(z.object({ chatId: z.uuid(), waId: z.string().min(1).max(128), favorita: z.boolean(), deMim: z.boolean().optional() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const personId = await pessoa();
    await withPerson(getPool(), personId, (db) =>
      db
        .insert(schema.whatsappMessageFlags)
        .values({ personId, chatId: data.chatId, waId: data.waId, starred: data.favorita })
        .onConflictDoUpdate({ target: [schema.whatsappMessageFlags.personId, schema.whatsappMessageFlags.chatId, schema.whatsappMessageFlags.waId], set: { starred: data.favorita, updatedAt: new Date() } }),
    );
    await noCelular(personId, data.chatId, (p, linha, c) => p.favoritar(linha, c.jid, data.waId, data.deMim ?? false, data.favorita));
    return { ok: true };
  });

/** Fixar uma mensagem no topo da conversa (até 3, como no WhatsApp: a mais antiga sai). Só o dono do número. */
export const fixarMensagem = createServerFn({ method: "POST" })
  .validator(z.object({ chatId: z.uuid(), waId: z.string().min(1).max(128), fixar: z.boolean(), deMim: z.boolean().optional(), autorId: z.string().max(200).nullable().optional() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const personId = await pessoa();
    await withPerson(getPool(), personId, async (db) => {
      const c = await conversa(db, personId, data.chatId);
      if (!c.responde) throw new ErroParaTela("Só quem responde por este número fixa mensagens.");
      const p = schema.whatsappPinnedMessages;
      if (!data.fixar) {
        await db.delete(p).where(and(eq(p.chatId, data.chatId), eq(p.waId, data.waId)));
        return;
      }
      await db.insert(p).values({ chatId: data.chatId, waId: data.waId, pinnedBy: personId }).onConflictDoNothing();
      const fixadas = await db.select({ waId: p.waId }).from(p).where(eq(p.chatId, data.chatId)).orderBy(sql`${p.pinnedAt} DESC`);
      for (const f of fixadas.slice(3)) await db.delete(p).where(and(eq(p.chatId, data.chatId), eq(p.waId, f.waId)));
    });
    // No WhatsApp, a mensagem fixada aparece para todos na conversa (como no celular).
    await noCelular(personId, data.chatId, (p, linha, c) =>
      p.fixarMensagem(linha, c.jid, { id: data.waId, fromMe: data.deMim ?? false, participante: c.grupo && !data.deMim ? (data.autorId ?? null) : null }, data.fixar),
    );
    return { ok: true };
  });

/** Fixar a conversa no topo da lista desta pessoa (até 3, como no WhatsApp). */
export const fixarConversa = createServerFn({ method: "POST" })
  .validator(z.object({ chatId: z.uuid(), fixar: z.boolean() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const personId = await pessoa();
    await withPerson(getPool(), personId, async (db) => {
      const p = schema.whatsappChatPins;
      if (!data.fixar) {
        await db.delete(p).where(and(eq(p.personId, personId), eq(p.chatId, data.chatId)));
        return;
      }
      const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(p).where(eq(p.personId, personId));
      if ((n?.n ?? 0) >= 3) throw new ErroParaTela("Dá para fixar até 3 conversas. Desafixe uma antes.");
      await db.insert(p).values({ personId, chatId: data.chatId }).onConflictDoNothing();
    });
    await noCelular(personId, data.chatId, (p, linha, c) => p.fixarConversa(linha, c.jid, data.fixar));
    return { ok: true };
  });

/**
 * Adicionar (ou editar) contato, como no WhatsApp Web (0088): com o envio real e a ponte de ações
 * ligada, salva na agenda do celular do número — e por ela em todos os aparelhos; sem isso
 * (ensaio), fica só no Omni (nome dado no Omni). Só o dono do número.
 */
export const salvarContatoWhatsApp = createServerFn({ method: "POST" })
  .validator(
    z.object({
      numberId: z.uuid(),
      telefone: z.string().regex(/^\d{8,15}$/, "Número inválido."),
      nome: z.string().trim().min(1, "Escreva o nome.").max(120),
      /** Conversa com a pessoa (quando há): no ensaio, o nome fica nela. */
      chatId: z.uuid().optional(),
    }),
  )
  .handler(async ({ data }): Promise<{ noCelular: boolean }> => {
    const personId = await pessoa();
    const [numero] = await withPerson(getPool(), personId, (db) =>
      db
        .select({ dono: schema.whatsappNumbers.ownerPersonId, telefone: schema.whatsappNumbers.phone, status: schema.whatsappNumbers.status })
        .from(schema.whatsappNumbers)
        .where(eq(schema.whatsappNumbers.id, data.numberId)),
    );
    if (!numero || numero.dono !== personId) throw new ErroParaTela("Só o dono do número adiciona contatos.");
    const jid = `${data.telefone}@s.whatsapp.net`;
    const ponte = getPonteDeAcoes();
    let noCelular = false;
    if (getEnv().WHATSAPP_ENVIO === "real" && ponte && numero.status === "conectado" && numero.telefone) {
      try {
        await ponte.salvarContato(numero.telefone, jid, data.nome);
        noCelular = true;
      } catch {
        throw new ErroParaTela("O WhatsApp não salvou o contato agora. Confira se o número está conectado e tente de novo.");
      }
    }
    await withPerson(getPool(), personId, async (db) => {
      await db
        .insert(schema.whatsappContacts)
        .values({ numberId: data.numberId, jid, phone: data.telefone, savedName: data.nome })
        .onConflictDoUpdate({ target: [schema.whatsappContacts.numberId, schema.whatsappContacts.jid], set: { savedName: data.nome, updatedAt: new Date() } });
      // Fora do celular (ensaio, ponte desligada), o nome também fica na conversa (nome dado no Omni).
      if (!noCelular && data.chatId) await db.execute(sql`SELECT app.whatsapp_renomear_contato(${data.chatId}::uuid, ${data.nome})`);
    });
    return { noCelular };
  });

