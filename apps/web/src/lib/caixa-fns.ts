import { tituloMissao } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { GraphError, type PastaDeEmail, type ResumoDeEmail } from "@omni/integrations/graph";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { daConversa } from "../server/email-conversa.ts";
import { getPool } from "../server/db.ts";
import { imagensEmbutidas, nomeEEndereco } from "../server/email-graph.ts";
import { limparHtmlEmail, politicaDoQuadro } from "../server/email-html.ts";
import { getEnv } from "../server/env.ts";
import { getGraph } from "../server/graph.ts";
import { personIdFromRequest } from "../server/session.ts";
import type { EmailAberto } from "./emails-fns.ts";
import { ErroParaTela } from "./erros.ts";
import { enderecoDoProxy } from "../server/email-imagem.ts";
import { anexosSchema, lerAnexos } from "../server/email-anexos.ts";
import { exigirModulo } from "../server/modulos.ts";

/**
 * Aba E-mails: a caixa da PRÓPRIA pessoa, lida na hora no Microsoft 365 (nada é
 * copiado para o Omni). A caixa é sempre a da sessão (app.minha_caixa_email): nunca
 * vem do navegador. O Exchange decide de fato (grupo "Omni - Caixas").
 */

export type MinhaCaixa = { disponivel: boolean; caixa: string | null; pastas: PastaDeEmail[]; erro: string | null };
export type EmailDaCaixa = EmailAberto & {
  id: string;
  /** Endereços para "Responder a todos" (sem a própria caixa). */
  todos: { para: string[]; cc: string[] };
  /** Missões a que este e-mail está ligado e que a pessoa vê. */
  missoes: { id: string; titulo: string }[];
  /** Lido na caixa (abrir marca como lido, como no Outlook, quando o Omni tem a permissão). */
  lido: boolean;
  /** Acabou de ser marcado como lido ao abrir: a lista se atualiza. */
  marcadoAgora: boolean;
};

const ID_GRAPH = z.string().regex(/^[A-Za-z0-9_=+/-]{10,600}$/, "E-mail inválido.");

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  await exigirModulo(id, "emails");
  return id;
}

/** A caixa da pessoa da sessão (só se liberada no Omni) e o Graph. */
async function minhaCaixaEGraph() {
  const personId = await pessoa();
  const graph = getGraph();
  const [c] = await withPerson(getPool(), personId, (db) => db.execute<{ caixa: string | null }>(sql`SELECT app.minha_caixa_email() AS caixa`)).then((r) => r.rows);
  return { personId, graph, caixa: c?.caixa ?? null };
}

function erroDoGraph(error: unknown): never {
  if (error instanceof GraphError) {
    if (error.status === 403) throw new ErroParaTela('Sua caixa ainda não está liberada para o Omni no Microsoft 365 (grupo "Omni - Caixas"). Avise a administração.');
    if (error.status === 404) throw new ErroParaTela("O e-mail não está mais na caixa (foi apagado ou movido).");
    throw new ErroParaTela("O Microsoft 365 não respondeu agora. Tente de novo em instantes.");
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new ErroParaTela("O Microsoft 365 demorou a responder. Tente de novo em instantes.");
  throw error;
}

export const minhaCaixa = createServerFn({ method: "GET" }).handler(async (): Promise<MinhaCaixa> => {
  const { graph, caixa } = await minhaCaixaEGraph();
  if (!graph) return { disponivel: false, caixa, pastas: [], erro: null };
  if (!caixa) return { disponivel: true, caixa: null, pastas: [], erro: null };
  try {
    return { disponivel: true, caixa, pastas: await graph.pastasDeEmail(caixa), erro: null };
  } catch (error) {
    // 404 aqui é a caixa que não existe no Microsoft 365 (não um e-mail que sumiu).
    if (error instanceof GraphError && error.status === 404)
      return { disponivel: true, caixa, pastas: [], erro: "Sua caixa de e-mail não foi encontrada no Microsoft 365. Avise a administração." };
    try {
      erroDoGraph(error);
    } catch (e) {
      if (e instanceof ErroParaTela) return { disponivel: true, caixa, pastas: [], erro: e.message };
      throw e;
    }
  }
});

export const listarMinhaCaixa = createServerFn({ method: "GET" })
  .validator(z.object({ pastaId: ID_GRAPH, inicio: z.number().int().min(0).max(5000).default(0), busca: z.string().trim().max(120).optional() }))
  .handler(async ({ data }): Promise<{ mensagens: ResumoDeEmail[]; haMais: boolean }> => {
    const { graph, caixa } = await minhaCaixaEGraph();
    if (!graph || !caixa) throw new ErroParaTela("Sua caixa de e-mail ainda não está conectada ao Omni.");
    try {
      return await graph.mensagensDaPasta(caixa, data.pastaId, { inicio: data.inicio, ...(data.busca ? { busca: data.busca } : {}) });
    } catch (error) {
      erroDoGraph(error);
    }
  });

export const abrirDaMinhaCaixa = createServerFn({ method: "POST" })
  .validator(z.object({ id: ID_GRAPH, permitirExternas: z.boolean().optional() }))
  .handler(async ({ data }): Promise<EmailDaCaixa> => {
    const { personId, graph, caixa } = await minhaCaixaEGraph();
    if (!graph || !caixa) throw new ErroParaTela("Sua caixa de e-mail ainda não está conectada ao Omni.");
    try {
      const m = await graph.mensagem(caixa, data.id);
      // Abrir marca como lido, como no Outlook. Sem a permissão (Mail.ReadWrite), só abre.
      let lido = m.isRead ?? true;
      let marcadoAgora = false;
      if (!lido) {
        try {
          await graph.marcarComoLido(caixa, data.id, true);
          await guardarLido(personId, data.id, true);
          lido = true;
          marcadoAgora = true;
        } catch {
          // sem permissão ou o Graph recusou agora: o e-mail abre do mesmo jeito
        }
      }
      const permitirExternas = Boolean(data.permitirExternas);
      let html: string | null = null;
      let externasBloqueadas = 0;
      try {
        const bruto = await graph.corpoHtml(caixa, data.id);
        if (bruto && bruto.length <= 2_000_000) {
          const r = limparHtmlEmail(bruto, { imagensCid: await imagensEmbutidas(graph, caixa, data.id, m.anexos), permitirExternas, proxy: (u) => enderecoDoProxy(getEnv().AUTH_SECRET, u) });
          html = r.html;
          externasBloqueadas = r.externasBloqueadas;
        }
      } catch {
        // Sem HTML: mostra o texto.
      }
      // Missões a que o e-mail está ligado (pelo identificador da mensagem), entre as que a pessoa vê.
      const missoes = m.internetMessageId
        ? await withPerson(getPool(), personId, async (db) => {
            const ids = (
              await db
                .select({ id: schema.mailMessageMissions.missionId })
                .from(schema.mailMessageMissions)
                .innerJoin(schema.mailMessages, eq(schema.mailMessages.id, schema.mailMessageMissions.messageId))
                .where(eq(schema.mailMessages.internetMessageId, m.internetMessageId!))
            ).map((x) => x.id);
            if (!ids.length) return [];
            const vistas = await db
              .select({ id: schema.missions.id, code: schema.missions.code, cliente: schema.missions.clientName })
              .from(schema.missions)
              .where(and(inArray(schema.missions.id, ids)));
            return vistas.map((v) => ({ id: v.id, titulo: tituloMissao(v.code, v.cliente) }));
          }).catch(() => [])
        : [];
      const eu = caixa.toLowerCase();
      const enderecos = (l: typeof m.toRecipients) => (l ?? []).map((d) => d.emailAddress.address?.toLowerCase() ?? "").filter((a) => a && a !== eu);
      const remetente = m.from?.emailAddress.address?.toLowerCase();
      return {
        id: data.id,
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
        leituras: [],
        todos: { para: [...new Set([...(remetente && remetente !== eu ? [remetente] : []), ...enderecos(m.toRecipients)])], cc: enderecos(m.ccRecipients) },
        missoes,
        lido,
        marcadoAgora,
      };
    } catch (error) {
      erroDoGraph(error);
    }
  });

/** O cabeçalho guardado (caixa única, 0067) acompanha o lido da caixa; só os da própria pessoa (RLS). */
async function guardarLido(personId: string, graphId: string, lido: boolean) {
  await withPerson(getPool(), personId, (db) =>
    db.update(schema.mailItems).set({ isRead: lido }).where(and(eq(schema.mailItems.graphId, graphId), eq(schema.mailItems.ownerPersonId, personId))),
  ).catch(() => undefined);
}

/** Marca como lido ou não lido na própria caixa do Microsoft 365. */
export const marcarLidoNaMinhaCaixa = createServerFn({ method: "POST" })
  .validator(z.object({ id: ID_GRAPH, lido: z.boolean() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { personId, graph, caixa } = await minhaCaixaEGraph();
    if (!graph || !caixa) throw new ErroParaTela("Sua caixa de e-mail ainda não está conectada ao Omni.");
    try {
      await graph.marcarComoLido(caixa, data.id, data.lido);
    } catch (error) {
      if (error instanceof GraphError && error.status === 403)
        throw new ErroParaTela('O Omni ainda não tem permissão para marcar e-mails como lidos no Microsoft 365 ("Application Mail.ReadWrite"). Avise a administração.');
      erroDoGraph(error);
    }
    await guardarLido(personId, data.id, data.lido);
    return { ok: true };
  });

/**
 * Caixa única: marca como lidos os e-mails não lidos da Entrada com estes endereços (até 50),
 * ou o mais recente como não lido. Só na própria caixa.
 */
export const marcarEmailsDoContato = createServerFn({ method: "POST" })
  .validator(z.object({ enderecos: z.array(z.email().transform((e) => e.toLowerCase())).min(1).max(20), lido: z.boolean() }))
  .handler(async ({ data }): Promise<{ marcados: number }> => {
    const { personId, graph, caixa } = await minhaCaixaEGraph();
    if (!graph || !caixa) throw new ErroParaTela("Sua caixa de e-mail ainda não está conectada ao Omni.");
    const lista = `{${data.enderecos.map((e) => `"${e.replace(/["\\]/g, "")}"`).join(",")}}`;
    const alvos = await withPerson(getPool(), personId, (db) =>
      db
        .select({ graphId: schema.mailItems.graphId })
        .from(schema.mailItems)
        .where(
          and(
            eq(schema.mailItems.ownerPersonId, personId),
            eq(schema.mailItems.folder, "inbox"),
            sql`${schema.mailItems.addresses} && ${lista}::text[]`,
            // Só os que a pessoa mandou para mim (eu no Para): cópia não é da conversa (0092).
            daConversa(lista),
            data.lido ? eq(schema.mailItems.isRead, false) : sql`true`,
          ),
        )
        .orderBy(sql`${schema.mailItems.receivedAt} DESC NULLS LAST`)
        .limit(data.lido ? 50 : 1),
    );
    let marcados = 0;
    for (const a of alvos) {
      try {
        await graph.marcarComoLido(caixa, a.graphId, data.lido);
      } catch (error) {
        if (error instanceof GraphError && error.status === 403)
          throw new ErroParaTela('O Omni ainda não tem permissão para marcar e-mails como lidos no Microsoft 365 ("Application Mail.ReadWrite"). Avise a administração.');
        if (error instanceof GraphError && error.status === 404) continue; // já não está na caixa
        erroDoGraph(error);
      }
      await guardarLido(personId, a.graphId, data.lido);
      marcados += 1;
    }
    return { marcados };
  });

const enderecos = z.array(z.email("E-mail inválido.").transform((e) => e.trim().toLowerCase())).max(50);

/** Novo e-mail ou resposta no mesmo fio, da própria caixa; registrado em mail_outbox (sem missão). */
export const enviarDaMinhaCaixa = createServerFn({ method: "POST" })
  .validator(
    z.object({
      para: enderecos.min(1, "Informe ao menos um destinatário."),
      cc: enderecos.default([]),
      cco: enderecos.default([]),
      assunto: z.string().trim().min(1, "Informe o assunto.").max(300),
      texto: z.string().trim().min(1, "Escreva a mensagem.").max(20000),
      responderA: ID_GRAPH.optional(),
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
      const [linha] = await db
        .insert(schema.mailOutbox)
        .values({ personId, missionId: null, fromAddress: c.caixa, toRecipients: data.para, ccRecipients: data.cc, bccRecipients: data.cco, subject: data.assunto, body: corpo, attachments: registro, mode: modo })
        .returning({ id: schema.mailOutbox.id });
      return { id: linha!.id, de: c.caixa, corpo };
    });
    if (!preparo) throw new ErroParaTela("Sua caixa de e-mail ainda não está conectada ao Omni.");
    const concluir = (status: "ensaio" | "enviado" | "falhou", erro: string | null = null) =>
      withPerson(getPool(), personId, (db) => db.update(schema.mailOutbox).set({ status, error: erro, sentAt: status === "enviado" ? new Date() : null }).where(eq(schema.mailOutbox.id, preparo.id)));
    if (modo === "ensaio") {
      await concluir("ensaio");
      return { modo };
    }
    try {
      const e = { para: data.para, cc: data.cc, cco: data.cco, texto: preparo.corpo, anexos };
      if (data.responderA) await graph!.responderEmail(preparo.de, data.responderA, e);
      else await graph!.enviarEmail(preparo.de, { ...e, assunto: data.assunto });
      await concluir("enviado");
      return { modo };
    } catch (error) {
      await concluir("falhou", error instanceof GraphError ? `Microsoft 365 respondeu ${error.status}` : "erro");
      erroDoGraph(error);
    }
  });

/** Aviso de e-mail novo (0067): o item da caixa da própria pessoa → id do Graph para abrir. */
export const emailDoAviso = createServerFn({ method: "GET" })
  .validator(z.object({ itemId: z.uuid() }))
  .handler(async ({ data }): Promise<{ graphId: string } | null> => {
    const personId = await pessoa();
    const [i] = await withPerson(getPool(), personId, (db) =>
      db.select({ graphId: schema.mailItems.graphId }).from(schema.mailItems).where(eq(schema.mailItems.id, data.itemId)),
    );
    return i ?? null;
  });

