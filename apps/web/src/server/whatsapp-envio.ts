import { dentroDoLimite, podeSairPeloWhatsApp } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { WhatsAppError } from "@omni/integrations/whatsapp";
import { eq, sql } from "drizzle-orm";

import { ErroParaTela } from "../lib/erros.ts";
import { getPool } from "./db.ts";
import { getEnv } from "./env.ts";
import { getWhatsApp } from "./whatsapp.ts";

/**
 * Envio pelo WhatsApp (só servidor), o mesmo caminho para texto e arquivo:
 * origem só "conversa" (Interno/Gerencial nunca), limite por minuto, registro
 * em whatsapp_outbox (RLS: só quem vê o número, com o número conectado) e,
 * conforme WHATSAPP_ENVIO, ensaio (registra e não sai) ou envio real.
 */

/** `voz`: gravado no Omni, sai como mensagem de voz (não como arquivo de áudio). */
export type ArquivoParaEnviar = { conteudo: Buffer; mimetype: string; nome: string; voz?: boolean };

/** Gravação do navegador (Chrome: WebM/Opus; Safari: MP4/AAC). */
export const TIPOS_VOZ = /^audio\/(webm|ogg|mp4|mpeg|aac)$/;

/** Tipos aceitos para envio (o WhatsApp entrega como foto, vídeo, áudio ou documento). */
export const TIPOS_ARQUIVO = /^(image\/(jpeg|png|webp)|video\/mp4|audio\/(mpeg|ogg|mp4|aac)|application\/(pdf|zip|msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-excel|vnd\.ms-powerpoint)|text\/(plain|csv))$/;
export const MAX_ARQUIVO = 16 * 1024 * 1024;

export async function enviarPeloWhatsApp(personId: string, chatId: string, texto: string, arquivo?: ArquivoParaEnviar): Promise<{ modo: "ensaio" | "real" }> {
  if (!podeSairPeloWhatsApp("conversa")) throw new ErroParaTela("Envio não permitido.");
  const modo = getEnv().WHATSAPP_ENVIO;
  if (modo === "desligado") throw new ErroParaTela("O envio pelo WhatsApp está desligado neste ambiente.");
  if (arquivo?.voz && (!TIPOS_VOZ.test(arquivo.mimetype) || arquivo.conteudo.length > MAX_ARQUIVO || !arquivo.conteudo.length)) {
    throw new ErroParaTela("Áudio não aceito: grave de novo (até 16 MB).");
  }
  if (arquivo && !arquivo.voz && (!TIPOS_ARQUIVO.test(arquivo.mimetype) || arquivo.conteudo.length > MAX_ARQUIVO || !arquivo.conteudo.length)) {
    throw new ErroParaTela("Arquivo não aceito: use foto, PDF, documento do Office, áudio ou vídeo de até 16 MB.");
  }
  const { saida, alvo } = await withPerson(getPool(), personId, async (db) => {
    const [conversa] = await db
      .select({
        jid: schema.whatsappChats.jid,
        telefone: schema.whatsappChats.phone,
        grupo: schema.whatsappChats.isGroup,
        numberId: schema.whatsappChats.numberId,
        instancia: schema.whatsappNumbers.instanceName,
      })
      .from(schema.whatsappChats)
      .innerJoin(schema.whatsappNumbers, eq(schema.whatsappNumbers.id, schema.whatsappChats.numberId))
      .where(eq(schema.whatsappChats.id, chatId));
    if (!conversa) throw new ErroParaTela("Conversa não encontrada.");
    // Contato identificado só por @lid (sem número): o WhatsApp não aceita envio por esse identificador.
    if (!conversa.grupo && !conversa.telefone && conversa.jid.endsWith("@lid")) throw new ErroParaTela("Este contato não mostra o número. Responda pelo celular.");
    const minuto = new Date(Date.now() - 60_000);
    const [contagem] = (
      await db.execute<{ pessoa: number; numero: number }>(sql`
        SELECT count(*) FILTER (WHERE o.person_id = ${personId}::uuid)::int AS pessoa, count(*)::int AS numero
          FROM whatsapp_outbox o JOIN whatsapp_chats c ON c.id = o.chat_id
         WHERE c.number_id = ${conversa.numberId}::uuid AND o.created_at >= ${minuto}`)
    ).rows;
    if (!dentroDoLimite(contagem ?? { pessoa: 0, numero: 0 })) throw new ErroParaTela("Muitas mensagens em pouco tempo. Espere um minuto.");
    try {
      const [registro] = await db
        .insert(schema.whatsappOutbox)
        .values({
          chatId,
          personId,
          body: texto,
          mode: modo,
          ...(arquivo ? { fileName: arquivo.nome, fileMime: arquivo.mimetype, fileSize: arquivo.conteudo.length } : {}),
        })
        .returning({ id: schema.whatsappOutbox.id });
      return { saida: registro!.id, alvo: conversa };
    } catch {
      throw new ErroParaTela("Você não pode responder por este número (ou ele está desconectado).");
    }
  });
  if (modo === "ensaio") return { modo };
  const w = getWhatsApp();
  const para = alvo.grupo ? alvo.jid : (alvo.telefone ?? alvo.jid);
  try {
    if (!w) throw new WhatsAppError("WhatsApp não configurado", 503, "indisponivel");
    const enviada = arquivo?.voz
      ? await w.whatsapp.enviarAudio(alvo.instancia, para, arquivo.conteudo)
      : arquivo
        ? await w.whatsapp.enviarArquivo(alvo.instancia, para, { conteudo: arquivo.conteudo, mimetype: arquivo.mimetype, nome: arquivo.nome, legenda: texto || undefined })
        : await w.whatsapp.enviarTexto(alvo.instancia, para, texto);
    await withPerson(getPool(), personId, (db) => db.update(schema.whatsappOutbox).set({ status: "enviada", waId: enviada.id }).where(eq(schema.whatsappOutbox.id, saida)));
    return { modo };
  } catch (error) {
    await withPerson(getPool(), personId, (db) =>
      db.update(schema.whatsappOutbox).set({ status: "erro", error: error instanceof WhatsAppError ? (error.code ?? String(error.status)) : "erro" }).where(eq(schema.whatsappOutbox.id, saida)),
    );
    throw new ErroParaTela("A mensagem não saiu. Confira se o número está conectado e tente de novo.");
  }
}
