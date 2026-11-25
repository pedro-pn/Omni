import { schema, type Db } from "@omni/db";
import { lerMensagemEvolution, WhatsAppError, type EventoWhatsApp, type WhatsApp } from "@omni/integrations/whatsapp";
import { and, eq, ne, sql } from "drizzle-orm";

/**
 * Mensagens do WhatsApp no banco do Omni: as que chegam ao vivo (webhook).
 * O histórico de antes do pareamento fica na Evolution do Omni e é baixado só
 * para o aparelho do dono do número (12/11/2026; apps/web/src/lib/whatsapp-aparelho.ts).
 *
 * `recuperarRecentes` cobre o Omni fora do ar: relê na Evolution as últimas
 * horas e grava o que faltou (sem duplicar).
 */

type Mensagem = Extract<EventoWhatsApp, { tipo: "mensagem" }>;
export type FonteHistorico = Pick<WhatsApp, "mensagens" | "infoGrupo">;

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

/** Grava mensagens de um número (sem duplicar); devolve quantas eram novas e em quais conversas. */
export async function guardarMensagens(db: Db, numberId: string, mensagens: Mensagem[]): Promise<{ novas: number; conversas: Set<string> }> {
  const r = { novas: 0, conversas: new Set<string>() };
  const c = schema.whatsappChats;
  const porConversa = new Map<string, Mensagem[]>();
  for (const m of mensagens) porConversa.set(m.chatJid, [...(porConversa.get(m.chatJid) ?? []), m]);
  for (const [jid, lista] of porConversa) {
    const primeira = lista[0]!;
    const nome = primeira.grupo ? null : (lista.find((m) => !m.deMim && m.autorNome)?.autorNome ?? null);
    // Mesma regra do webhook: conversa pelo número, @lid guardado nela (0048).
    const lid = lista.find((m) => m.lid)?.lid ?? null;
    const [conversa] = (
      await db.execute<{ id: string }>(sql`SELECT app.whatsapp_conversa(${numberId}::uuid, ${jid}, ${lid}, ${primeira.grupo}, ${primeira.telefone}, ${nome}) AS id`)
    ).rows;
    const chatId = conversa!.id;
    for (let i = 0; i < lista.length; i += 500) {
      const lote = lista.slice(i, i + 500);
      const inseridas = await db
        .insert(schema.whatsappMessages)
        .values(
          lote.map((m) => ({
            chatId,
            waId: m.id,
            fromMe: m.deMim,
            authorJid: m.autorJid,
            authorName: m.autorNome,
            kind: m.conteudo,
            body: m.texto?.slice(0, 4096) ?? null,
            fileName: m.arquivo?.slice(0, 255) ?? null,
            sentAt: m.em,
            status: m.deMim ? ("enviada" as const) : null,
          })),
        )
        .onConflictDoNothing({ target: [schema.whatsappMessages.chatId, schema.whatsappMessages.waId] })
        .returning({ id: schema.whatsappMessages.id });
      r.novas += inseridas.length;
    }
    const ultima = lista.reduce((a, b) => (b.em > a.em ? b : a));
    await db
      .update(c)
      .set({ lastMessageAt: ultima.em, lastPreview: previa(ultima) })
      .where(and(eq(c.id, chatId), sql`(${c.lastMessageAt} IS NULL OR ${c.lastMessageAt} <= ${ultima.em})`));
    r.conversas.add(chatId);
  }
  return r;
}

/** Lê todas as páginas de mensagens de um filtro na Evolution (com teto, para não travar o worker). */
async function lerTudo(fonte: FonteHistorico, instancia: string, filtro: { jid?: string; desde?: Date }, maxPaginas: number): Promise<Mensagem[]> {
  const todas: Mensagem[] = [];
  for (let pagina = 1; pagina <= maxPaginas; pagina += 1) {
    const r = await fonte.mensagens(instancia, filtro, pagina, 200);
    for (const bruto of r.registros) {
      const m = lerMensagemEvolution(instancia, bruto);
      if (m && (!filtro.jid || m.chatJid === filtro.jid)) todas.push(m);
    }
    if (pagina >= r.paginas) break;
  }
  return todas;
}

export type ResultadoRecuperacao = { numeros: number; novas: number; erros: number };

/** Relê as últimas horas na Evolution e grava o que o webhook perdeu. */
export async function recuperarRecentes(db: Db, fonte: FonteHistorico, opcoes: { horas?: number; now?: () => Date } = {}): Promise<ResultadoRecuperacao> {
  const agora = (opcoes.now ?? (() => new Date()))();
  const desde = new Date(agora.getTime() - (opcoes.horas ?? 2) * 3_600_000);
  const r: ResultadoRecuperacao = { numeros: 0, novas: 0, erros: 0 };
  const numeros = await db.select().from(schema.whatsappNumbers).where(eq(schema.whatsappNumbers.status, "conectado"));
  for (const n of numeros) {
    r.numeros += 1;
    let mensagens: Mensagem[];
    try {
      mensagens = await lerTudo(fonte, n.instanceName, { desde }, 20);
    } catch (error) {
      if (!(error instanceof WhatsAppError)) throw error;
      r.erros += 1;
      continue;
    }
    // Só o que é de depois do corte (a Evolution pode devolver um pouco antes).
    const g = await guardarMensagens(db, n.id, mensagens.filter((m) => m.em >= desde));
    r.novas += g.novas;
    if (g.novas) {
      for (const chatId of g.conversas) await db.execute(sql`SELECT pg_notify('omni_whatsapp', ${JSON.stringify({ numberId: n.id, chatId })})`);
    }
  }
  return r;
}
