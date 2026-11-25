import type { MotivoVinculo } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { GraphError } from "@omni/integrations/graph";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { getEnv } from "../server/env.ts";
import { imagensEmbutidas, nomeEEndereco } from "../server/email-graph.ts";
import { limparHtmlEmail, politicaDoQuadro } from "../server/email-html.ts";
import { getGraph } from "../server/graph.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";
import { enderecoDoProxy } from "../server/email-imagem.ts";
import { anexosSchema, lerAnexos } from "../server/email-anexos.ts";

/**
 * Aba E-mails da missão (Fase 4): e-mails das caixas autorizadas que se ligam
 * à missão, com o motivo do vínculo. Só diretoria e gerentes (app.ve_emails,
 * migration 0022). O corpo vem do Graph na hora de abrir — em texto puro — e
 * cada abertura fica registrada no banco (app.abrir_email).
 */

export type DestinatarioEmail = { nome: string | null; endereco: string };

export type EmailResumo = {
  id: string;
  de: string;
  deEndereco: string | null;
  para: DestinatarioEmail[];
  cc: DestinatarioEmail[];
  em: string | null;
  previa: string | null;
  anexos: boolean;
  motivos: { motivo: MotivoVinculo; detalhe: string }[];
  abertoPorMim: boolean;
};
export type ConversaEmail = { id: string; assunto: string; ultimoEm: string | null; mensagens: EmailResumo[] };
export type EmailsDaMissao = { podeVer: boolean; conversas: ConversaEmail[] };

export type EmailAberto = {
  assunto: string;
  de: string;
  para: string[];
  cc: string[];
  em: string | null;
  texto: string;
  /** Corpo em HTML já limpo no servidor (null: o e-mail é só texto). Mostrado num iframe isolado. */
  html: string | null;
  /** CSP do iframe (imagens externas só se liberadas). */
  politica: string;
  externasBloqueadas: number;
  anexos: { id: string; nome: string; tamanho: number | null; arquivo: boolean }[];
  leituras: { nome: string; em: string }[];
};

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

export const listarEmailsDaMissao = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<EmailsDaMissao> => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const [acesso] = (await db.execute<{ ok: boolean }>(sql`SELECT app.ve_emails() AS ok`)).rows;
      if (!acesso?.ok) return { podeVer: false, conversas: [] };
      const linhas = (
        await db.execute<{
          id: string;
          conversation_id: string | null;
          subject: string | null;
          from_name: string | null;
          from_address: string | null;
          to_recipients: DestinatarioEmail[];
          cc_recipients: DestinatarioEmail[];
          received_at: string | Date | null;
          body_preview: string | null;
          has_attachments: boolean;
          motivos: { motivo: MotivoVinculo; detalhe: string }[] | null;
          aberto_por_mim: boolean;
        }>(sql`SELECT * FROM app.emails_da_missao(${data.missionId}::uuid)`)
      ).rows;
      // Agrupa por conversa (a lista já vem do mais novo para o mais antigo).
      const conversas = new Map<string, ConversaEmail>();
      for (const l of linhas) {
        const chave = l.conversation_id ?? l.id;
        const em = l.received_at ? new Date(l.received_at).toISOString() : null;
        const c = conversas.get(chave) ?? { id: chave, assunto: l.subject?.trim() || "(sem assunto)", ultimoEm: em, mensagens: [] };
        c.mensagens.push({
          id: l.id,
          de: l.from_name || l.from_address || "(sem remetente)",
          deEndereco: l.from_address,
          para: l.to_recipients,
          cc: l.cc_recipients,
          em,
          previa: l.body_preview,
          anexos: l.has_attachments,
          motivos: l.motivos ?? [],
          abertoPorMim: l.aberto_por_mim,
        });
        conversas.set(chave, c);
      }
      // Dentro da conversa, do mais antigo para o mais novo (como uma conversa).
      for (const c of conversas.values()) c.mensagens.reverse();
      return { podeVer: true, conversas: [...conversas.values()] };
    });
  });

/** Tira o e-mail da missão (vínculo errado); a sincronização não religa. */
export const desvincularEmail = createServerFn({ method: "POST" })
  .validator(z.object({ messageId: z.uuid(), missionId: z.uuid() }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    const ok = await withPerson(getPool(), personId, async (db) => {
      const [r] = (await db.execute<{ ok: boolean }>(sql`SELECT app.desvincular_email(${data.messageId}::uuid, ${data.missionId}::uuid) AS ok`)).rows;
      return Boolean(r?.ok);
    });
    if (!ok) throw new ErroParaTela("Não foi possível tirar este e-mail da missão.");
    return { ok };
  });


export const abrirEmail = createServerFn({ method: "POST" })
  .validator(z.object({ messageId: z.uuid(), permitirExternas: z.boolean().optional() }))
  .handler(async ({ data }): Promise<EmailAberto> => {
    const personId = await pessoa();
    const graph = getGraph();
    if (!graph) throw new ErroParaTela("A leitura do Microsoft 365 ainda não foi configurada no Omni.");
    // Confere a permissão e registra a abertura antes de buscar o conteúdo.
    const { onde, leituras } = await withPerson(getPool(), personId, async (db) => {
      const [o] = (await db.execute<{ mailbox: string; graph_id: string }>(sql`SELECT * FROM app.abrir_email(${data.messageId}::uuid)`)).rows;
      const l = (await db.execute<{ nome: string; viewed_at: string | Date }>(sql`SELECT * FROM app.leituras_email(${data.messageId}::uuid)`)).rows;
      return { onde: o, leituras: l };
    });
    if (!onde) throw new ErroParaTela("Você não tem acesso a este e-mail, ou ele não está mais em nenhuma caixa autorizada.");
    try {
      const m = await graph.mensagem(onde.mailbox, onde.graph_id);
      const permitirExternas = Boolean(data.permitirExternas);
      let html: string | null = null;
      let externasBloqueadas = 0;
      try {
        const bruto = await graph.corpoHtml(onde.mailbox, onde.graph_id);
        if (bruto && bruto.length <= 2_000_000) {
          const r = limparHtmlEmail(bruto, { imagensCid: await imagensEmbutidas(graph, onde.mailbox, onde.graph_id, m.anexos), permitirExternas, proxy: (u) => enderecoDoProxy(getEnv().AUTH_SECRET, u) });
          html = r.html;
          externasBloqueadas = r.externasBloqueadas;
        }
      } catch {
        // Sem HTML: mostra o texto.
      }
      return {
        html,
        politica: politicaDoQuadro(permitirExternas, true),
        externasBloqueadas,
        assunto: m.subject?.trim() || "(sem assunto)",
        de: m.from ? nomeEEndereco(m.from) : "",
        para: (m.toRecipients ?? []).map(nomeEEndereco),
        cc: (m.ccRecipients ?? []).map(nomeEEndereco),
        em: m.receivedDateTime ?? m.sentDateTime ?? null,
        texto: m.body?.content ?? m.bodyPreview ?? "",
        anexos: m.anexos.filter((a) => !a.inline).map((a) => ({ id: a.id, nome: a.nome, tamanho: a.tamanho, arquivo: a.arquivo })),
        leituras: leituras.map((l) => ({ nome: l.nome, em: new Date(l.viewed_at).toISOString() })),
      };
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) throw new ErroParaTela("O e-mail não está mais na caixa (foi apagado ou movido).");
      if (error instanceof GraphError && error.status === 403) throw new ErroParaTela("O Omni perdeu o acesso a esta caixa no Microsoft 365. Avise a administração.");
      throw error;
    }
  });

// ---------------------------------------------------------------- envio (Fase 4)

export type ContextoEnvio = {
  /** A própria caixa, se estiver liberada no Omni; sem ela não se envia. */
  caixa: string | null;
  modo: "desligado" | "ensaio" | "real";
  assinatura: string;
  /** Endereços para sugerir (pessoas da empresa). */
  pessoas: { nome: string; email: string }[];
};

export const contextoEnvio = createServerFn({ method: "GET" }).handler(async (): Promise<ContextoEnvio> => {
  const personId = await pessoa();
  return withPerson(getPool(), personId, async (db) => {
    const [c] = (await db.execute<{ caixa: string | null }>(sql`SELECT app.minha_caixa_email() AS caixa`)).rows;
    const [a] = await db.select({ s: schema.emailSignatures.signature }).from(schema.emailSignatures).where(eq(schema.emailSignatures.personId, personId));
    const pessoas = await db
      .select({ nome: schema.people.displayName, email: schema.people.email })
      .from(schema.people)
      .where(and(eq(schema.people.active, true), sql`${schema.people.email} NOT LIKE '%.invalid'`))
      .orderBy(asc(schema.people.displayName));
    return { caixa: c?.caixa ?? null, modo: getEnv().EMAIL_ENVIO, assinatura: a?.s ?? "", pessoas };
  });
});

export const salvarAssinatura = createServerFn({ method: "POST" })
  .validator(z.object({ assinatura: z.string().max(2000, "Assinatura com no máximo 2.000 caracteres.") }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    await withPerson(getPool(), personId, (db) =>
      db
        .insert(schema.emailSignatures)
        .values({ personId, signature: data.assinatura.trim() })
        .onConflictDoUpdate({ target: schema.emailSignatures.personId, set: { signature: data.assinatura.trim(), updatedAt: new Date() } }),
    );
    return { ok: true };
  });

const enderecos = z.array(z.email("E-mail inválido.").transform((e) => e.trim().toLowerCase())).max(50);

export const enviarEmailDaMissao = createServerFn({ method: "POST" })
  .validator(
    z.object({
      missionId: z.uuid(),
      para: enderecos.min(1, "Informe ao menos um destinatário."),
      cc: enderecos.default([]),
      cco: enderecos.default([]),
      assunto: z.string().trim().min(1, "Informe o assunto.").max(300),
      texto: z.string().trim().min(1, "Escreva a mensagem.").max(20000),
      responderA: z.uuid().optional(),
      anexos: anexosSchema,
    }),
  )
  .handler(async ({ data }): Promise<{ modo: "ensaio" | "real" }> => {
    const personId = await pessoa();
    const { anexos, registro } = lerAnexos(data.anexos);
    const modo = getEnv().EMAIL_ENVIO;
    if (modo === "desligado") throw new ErroParaTela("O envio de e-mail pelo Omni está desligado.");
    const graph = getGraph();
    if (modo === "real" && !graph) throw new ErroParaTela("A conexão com o Microsoft 365 não está configurada no Omni.");

    // Registra antes de enviar (é a auditoria); o banco só aceita a própria caixa liberada.
    const preparo = await withPerson(getPool(), personId, async (db) => {
      const [c] = (await db.execute<{ caixa: string | null }>(sql`SELECT app.minha_caixa_email() AS caixa`)).rows;
      if (!c?.caixa) return null;
      const [a] = await db.select({ s: schema.emailSignatures.signature }).from(schema.emailSignatures).where(eq(schema.emailSignatures.personId, personId));
      const corpo = a?.s ? `${data.texto}\n\n-- \n${a.s}` : data.texto;
      const [copia] = data.responderA
        ? (await db.execute<{ graph_id: string | null }>(sql`SELECT app.copia_na_minha_caixa(${data.responderA}::uuid) AS graph_id`)).rows
        : [];
      const [linha] = await db
        .insert(schema.mailOutbox)
        .values({
          personId,
          missionId: data.missionId,
          fromAddress: c.caixa,
          toRecipients: data.para,
          ccRecipients: data.cc,
          bccRecipients: data.cco,
          subject: data.assunto,
          body: corpo,
          replyToMessage: data.responderA ?? null,
          attachments: registro,
          mode: modo,
        })
        .returning({ id: schema.mailOutbox.id });
      return { id: linha!.id, de: c.caixa, corpo, copia: copia?.graph_id ?? null };
    });
    if (!preparo) throw new ErroParaTela("Sua caixa de e-mail ainda não está liberada no Omni. Peça à administração para cadastrá-la.");

    const concluir = (status: "ensaio" | "enviado" | "falhou", erro: string | null = null) =>
      withPerson(getPool(), personId, (db) =>
        db
          .update(schema.mailOutbox)
          .set({ status, error: erro, sentAt: status === "enviado" ? new Date() : null })
          .where(eq(schema.mailOutbox.id, preparo.id)),
      );

    if (modo === "ensaio") {
      await concluir("ensaio");
      return { modo };
    }
    try {
      const e = { para: data.para, cc: data.cc, cco: data.cco, texto: preparo.corpo, anexos };
      // Resposta no mesmo fio quando o e-mail está na própria caixa; senão, e-mail novo com o assunto.
      if (preparo.copia) await graph!.responderEmail(preparo.de, preparo.copia, e);
      else await graph!.enviarEmail(preparo.de, { ...e, assunto: data.assunto });
      await concluir("enviado");
      return { modo };
    } catch (error) {
      await concluir("falhou", error instanceof GraphError ? `Microsoft 365 respondeu ${error.status}` : "falha no envio");
      throw new ErroParaTela("O e-mail não foi enviado. Tente de novo em alguns minutos.");
    }
  });
