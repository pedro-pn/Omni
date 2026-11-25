import { corpoProprio, ehEnderecoAutomatico, entradaAssinatura, telefoneCanonico, telefonesNoTexto, ESQUEMA_ASSINATURA, SISTEMA_ASSINATURA, trechoDaAssinatura, validarAssinatura, VERSAO_PROMPT_ASSINATURA } from "@omni/core";
import { schema, type Db } from "@omni/db";
import { LlmError, type Llm } from "@omni/integrations/openai";
import { sql } from "drizzle-orm";

/**
 * Nome, cargo, empresa e telefone pela assinatura (job `ia-assinaturas`, IA_ASSINATURAS):
 * para cada remetente externo — dos e-mails ligados a missões e, desde 24/11/2026 (0076),
 * também da Entrada das caixas pessoais — o e-mail mais recente dele é lido no Graph, só o
 * final (sem a conversa citada) vai ao modelo e cada campo é conferido no texto. O texto não
 * é guardado; a extração vale por 180 dias.
 * No mesmo e-mail, os telefones CITADOS no corpo (sem a conversa citada) são achados aqui,
 * sem IA, e ficam como sugestão (contact_phone_hints) — nunca vinculados sozinhos.
 */

export type LerEmail = (caixa: string, graphId: string) => Promise<string | null>;
const SEM_CREDITO = new Set(["insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached"]);

/** Identificadores do e-mail lido para o registro da chamada ao modelo (nunca o texto). */
const idsDoEmail = (p: { message_id: string | null; item_id: string | null }): Record<string, string> => ({
  ...(p.message_id ? { messageId: p.message_id } : {}),
  ...(p.item_id ? { itemId: p.item_id } : {}),
  prompt: VERSAO_PROMPT_ASSINATURA,
});

export async function lerAssinaturas(db: Db, ler: LerEmail, llm: Llm, opcoes: { modelo: string; limite?: number }): Promise<{ lidas: number; ok: number; semAssinatura: number; erros: number }> {
  const r = { lidas: 0, ok: 0, semAssinatura: 0, erros: 0 };
  const pendentes = (
    await db.execute<{ address: string; nome: string | null; message_id: string | null; item_id: string | null; graph_id: string; caixa: string; tentativas: number }>(sql`
      WITH candidatos AS (
        -- Remetentes dos e-mails das missões.
        SELECT lower(m.from_address) AS address, m.from_name AS nome, m.id AS message_id, NULL::uuid AS item_id, c.graph_id, b.email::text AS caixa,
               coalesce(m.received_at, m.sent_at) AS em
          FROM mail_messages m
          JOIN mail_message_missions l ON l.message_id = m.id
          JOIN mail_message_copies c ON c.message_id = m.id
          JOIN mail_mailboxes b ON b.id = c.mailbox_id AND b.active
         WHERE m.from_address LIKE '%@%'
        UNION ALL
        -- Remetentes da Entrada das caixas pessoais (0067/0076).
        SELECT i.from_address, i.from_name, NULL::uuid, i.id, i.graph_id, b.email::text, coalesce(i.received_at, i.sent_at)
          FROM mail_items i
          JOIN mail_mailboxes b ON b.id = i.mailbox_id AND b.active
         WHERE i.folder = 'inbox' AND i.from_address LIKE '%@%'
      )
      SELECT DISTINCT ON (c.address) c.address, c.nome, c.message_id, c.item_id, c.graph_id, c.caixa, coalesce(s.attempts, 0) AS tentativas
        FROM candidatos c
        LEFT JOIN email_signature_extractions s ON s.address = c.address
       WHERE c.address NOT LIKE '%@filtrovali.com.br'
         AND (s.address IS NULL OR (s.status = 'erro' AND s.attempts < 3) OR s.extracted_at < now() - interval '180 days')
       ORDER BY c.address, c.em DESC NULLS LAST
       LIMIT ${opcoes.limite ?? 40}`)
  ).rows.filter((p) => !ehEnderecoAutomatico(p.address));
  // Telefones da própria empresa (WhatsApp de quem usa o Omni e telefones das pessoas) não são do contato.
  const daEmpresa = new Set(
    (
      await db.execute<{ t: string | null }>(sql`
        SELECT phone AS t FROM whatsapp_numbers WHERE phone IS NOT NULL
        UNION SELECT phone FROM people WHERE phone IS NOT NULL`)
    ).rows
      .map((x) => telefoneCanonico(x.t))
      .filter((x): x is string => Boolean(x)),
  );

  const gravar = (p: (typeof pendentes)[number], v: Partial<typeof schema.emailSignatureExtractions.$inferInsert> & { status: "ok" | "sem_assinatura" | "erro" }) =>
    db
      .insert(schema.emailSignatureExtractions)
      .values({ address: p.address, messageId: p.message_id, attempts: p.tentativas + 1, extractedAt: new Date(), nome: null, cargo: null, empresa: null, telefone: null, ...v })
      .onConflictDoUpdate({
        target: schema.emailSignatureExtractions.address,
        set: { messageId: p.message_id, attempts: p.tentativas + 1, extractedAt: new Date(), nome: v.nome ?? null, cargo: v.cargo ?? null, empresa: v.empresa ?? null, telefone: v.telefone ?? null, status: v.status, model: v.model ?? null },
      });

  for (const p of pendentes) {
    r.lidas += 1;
    let texto: string | null;
    try {
      texto = await ler(p.caixa, p.graph_id);
    } catch {
      r.erros += 1;
      await gravar(p, { status: "erro" });
      continue;
    }
    // Telefones citados no corpo (sem a conversa citada): sugestão, achados aqui mesmo, sem IA.
    if (texto) {
      const citados = telefonesNoTexto(corpoProprio(texto)).filter((t) => !daEmpresa.has(t));
      for (const t of citados.slice(0, 5)) {
        await db.insert(schema.contactPhoneHints).values({ address: p.address, phone: t }).onConflictDoUpdate({ target: [schema.contactPhoneHints.address, schema.contactPhoneHints.phone], set: { foundAt: new Date() } });
      }
    }
    const trecho = texto ? trechoDaAssinatura(texto) : "";
    if (trecho.length < 15) {
      r.semAssinatura += 1;
      await gravar(p, { status: "sem_assinatura" });
      continue;
    }
    try {
      const resposta = await llm.estruturado<unknown>({
        modelo: opcoes.modelo,
        sistema: SISTEMA_ASSINATURA,
        entrada: entradaAssinatura({ remetente: p.address, nomeNoCabecalho: p.nome, trecho }),
        nome: "assinatura",
        esquema: ESQUEMA_ASSINATURA as unknown as Record<string, unknown>,
      });
      await db.insert(schema.llmCalls).values({
        purpose: "assinatura",
        model: resposta.modelo,
        inputTokens: resposta.tokensEntrada,
        outputTokens: resposta.tokensSaida,
        durationMs: resposta.duracaoMs,
        outcome: "ok",
        dataIds: idsDoEmail(p),
      });
      const a = validarAssinatura(resposta.dados, trecho);
      const algum = a.nome || a.cargo || a.empresa || a.telefone;
      await gravar(p, { status: algum ? "ok" : "sem_assinatura", model: resposta.modelo, ...a });
      if (algum) r.ok += 1;
      else r.semAssinatura += 1;
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      r.erros += 1;
      await db.insert(schema.llmCalls).values({ purpose: "assinatura", model: opcoes.modelo, outcome: "erro", errorCode: error.code ?? String(error.status), dataIds: idsDoEmail(p) });
      await gravar(p, { status: "erro" });
      if (SEM_CREDITO.has(error.code ?? "")) break;
    }
  }
  return r;
}
