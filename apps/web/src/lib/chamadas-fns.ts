import { schema, withPerson } from "@omni/db";
import type { schema as esquemaTipos } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { getGraph } from "../server/graph.ts";
import { chamadasConfiguradas, controlarLinha, idTarefaDaChamada, servicoChamadas } from "../server/chamadas.ts";
import { ErroParaTela } from "./erros.ts";
import { exigirModulo } from "../server/modulos.ts";

/** Resumo pela IA (0038): só o que quem já ouve a gravação vê (RLS de whatsapp_calls). */
export type ResumoChamada = { texto: string; decisoes: string[]; pendencias: { descricao: string; responsavel: string | null; prazo: string | null }[] };
export function resumoDaChamada(c: { summary: { resumo: string; decisoes: string[]; pendencias: ResumoChamada["pendencias"] } | null; summaryStatus: string | null; transcript?: string | null }) {
  return {
    resumo: c.summary?.resumo ? { texto: c.summary.resumo, decisoes: c.summary.decisoes ?? [], pendencias: c.summary.pendencias ?? [] } : null,
    resumoSituacao: (c.summaryStatus ?? null) as "pendente" | "resumida" | "sem_fala" | "erro" | null,
    /** A transcrição vem à parte (transcricaoDaChamada): pode ser longa. */
    temTranscricao: Boolean(c.transcript),
  };
}

// Só tipo (import type): uma referência a `schema` fora dos handlers levaria o banco para o navegador.
type LinhaChamada = (typeof esquemaTipos.whatsappCalls)["$inferSelect"];
type Contatos = Record<string, { nome: string | null; chatId: string }>;
/** Uma ligação na lista (aba Ligações e aba Ligações da conversa). */
function itemDaLista(c: LinhaChamada, me: string, shares: { callId: string; personId: string }[], contatos: Contatos) {
  return { id: c.id, numeroId: c.numberId, telefone: c.peer, direcao: c.direction, estado: c.state,
    criadaEm: c.createdAt.toISOString(), inicio: c.startedAt?.toISOString() ?? null, fim: c.endedAt?.toISOString() ?? null,
    contato: contatos[`${c.numberId}:${c.peer}`] ?? null,
    minha: c.ownerPersonId === me, audio: c.audio && c.deletedAt === null && c.expiresAt > new Date(), erroGravacao: c.recordingError,
    compartilhadaCom: shares.filter(s => s.callId === c.id).map(s => s.personId), ...resumoDaChamada(c) };
}
export type LigacaoNaLista = ReturnType<typeof itemDaLista>;

async function pessoa() {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre novamente.");
  await exigirModulo(id, "chamadas");
  return id;
}
export const painelChamadas = createServerFn({ method: "GET" }).handler(async () => {
  const me = await pessoa();
  return withPerson(getPool(), me, async db => {
    const numeros = await db.select({ id: schema.whatsappNumbers.id, rotulo: schema.whatsappNumbers.label, telefone: schema.whatsappNumbers.phone, status: schema.whatsappNumbers.status })
      .from(schema.whatsappNumbers).where(and(eq(schema.whatsappNumbers.ownerPersonId, me), ne(schema.whatsappNumbers.status, "removido")));
    const [permission] = await db.select().from(schema.whatsappCallPermissions).where(eq(schema.whatsappCallPermissions.personId, me));
    const history = await db.select().from(schema.whatsappCalls).orderBy(desc(schema.whatsappCalls.createdAt)).limit(100);
    const shares = await db.select().from(schema.whatsappCallShares);
    const pessoas = (await db.execute<{ id: string; nome: string }>(sql`select * from app.pessoas_para_compartilhar_gravacao()`)).rows;
    // Nome e conversa de cada contato, pelas conversas individuais dos meus números (RLS: só o que vejo).
    const conversas = numeros.length
      ? await db
          .select({ numberId: schema.whatsappChats.numberId, chatId: schema.whatsappChats.id, nome: schema.whatsappChats.name, telefone: schema.whatsappChats.phone, jid: schema.whatsappChats.jid })
          .from(schema.whatsappChats)
          .where(and(inArray(schema.whatsappChats.numberId, numeros.map((n) => n.id)), eq(schema.whatsappChats.isGroup, false)))
      : [];
    const contatos: Contatos = {};
    for (const c of conversas) {
      const tel = c.telefone ?? c.jid.match(/^(\d{8,15})@s\.whatsapp\.net$/)?.[1];
      if (tel && !contatos[`${c.numberId}:${tel}`]) contatos[`${c.numberId}:${tel}`] = { nome: c.nome, chatId: c.chatId };
    }
    return { configurado: chamadasConfiguradas(), numeros, podeGravar: permission?.canRecord ?? false, pessoas, contatos,
      chamadas: history.map(c => itemDaLista(c, me, shares, contatos)) };
  });
});
export type PainelChamadas = Awaited<ReturnType<typeof painelChamadas>>;
export const acaoChamada = createServerFn({ method: "POST" })
  .validator(z.object({ numberId: z.uuid(), action: z.enum(["status", "connect", "disconnect", "ticket", "dial", "answer", "hangup", "reject", "record"]),
    peer: z.string().regex(/^[1-9][0-9]{9,14}$/).optional(), id: z.string().regex(/^[a-f0-9]{32}$/).optional(), record: z.boolean().optional(), notified: z.boolean().optional() }))
  .handler(async ({ data }) => { const { numberId, ...input } = data; return controlarLinha(await pessoa(), numberId, input); });

export const compartilharGravacao = createServerFn({ method: "POST" })
  .validator(z.object({ callId: z.uuid(), personId: z.uuid(), compartilhar: z.boolean() }))
  .handler(async ({ data }) => {
    const me = await pessoa();
    return withPerson(getPool(), me, async db => {
      const check = await db.execute<{ ok: boolean }>(sql`select app.chamada_dono(${data.callId}::uuid) as ok`);
      if (!check.rows[0]?.ok) throw new ErroParaTela("Só o dono pode compartilhar ou revogar o acesso à gravação.");
      if (data.compartilhar) {
        try { await db.insert(schema.whatsappCallShares).values({ callId: data.callId, personId: data.personId, sharedBy: me }).onConflictDoNothing(); }
        catch { throw new ErroParaTela("Não foi possível compartilhar essa gravação."); }
      } else await db.delete(schema.whatsappCallShares).where(and(eq(schema.whatsappCallShares.callId, data.callId), eq(schema.whatsappCallShares.personId, data.personId)));
      await db.insert(schema.auditLog).values({ actorPersonId: me, action: data.compartilhar ? "chamada.compartilhada" : "chamada.compartilhamento_revogado", entityType: "whatsapp_call", entityId: data.callId, metadata: { personId: data.personId } });
      return { ok: true };
    });
  });
export const excluirGravacao = createServerFn({ method: "POST" }).validator(z.object({ callId: z.uuid() })).handler(async ({ data }) => {
  const me = await pessoa();
  const c = await withPerson(getPool(), me, async db => {
    const [call] = await db.select().from(schema.whatsappCalls).where(eq(schema.whatsappCalls.id, data.callId));
    if (!call || call.ownerPersonId !== me) throw new ErroParaTela("Só o dono pode excluir a gravação.");
    await db.execute(sql`select app.excluir_gravacao(${call.id}::uuid)`); return call;
  });
  // O banco revoga acesso antes da remoção física. Se o motor estiver fora do
  // ar, o arquivo continua privado e a retenção do serviço o remove depois.
  await servicoChamadas(`/internal/recordings/${c.numberId}/${c.ownerPersonId}/${c.recordingId}`, { method: "DELETE" }).catch(() => undefined);
  // Arquivada no SharePoint (0052): apaga de vez já; se falhar, o worker (chamadas-arquivar) tenta de novo.
  if (c.spDriveId && c.spItemId) await getGraph()?.apagarDefinitivo(c.spDriveId, c.spItemId).catch(() => undefined);
  return { ok: true };
});

/** Pendência do resumo da ligação vira tarefa na caixa pessoal de quem pediu (id fixo: não duplica). */
export const pendenciaDaChamadaParaTarefa = createServerFn({ method: "POST" })
  .validator(z.object({ callId: z.uuid(), indice: z.number().int().min(0).max(30) }))
  .handler(async ({ data }): Promise<{ id: string; jaExistia: boolean }> => {
    const me = await pessoa();
    return withPerson(getPool(), me, async db => {
      const [call] = await db.select().from(schema.whatsappCalls).where(eq(schema.whatsappCalls.id, data.callId));
      const p = call?.summary?.pendencias[data.indice];
      if (!call || !p) throw new ErroParaTela("Pendência não encontrada.");
      const id = idTarefaDaChamada(call.id, data.indice);
      const [existe] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.id, id));
      if (existe) return { id, jaExistia: true };
      const quando = (call.endedAt ?? call.createdAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });
      const descricao = [
        `Pendência da ligação ${call.direction === "entrada" ? "recebida de" : "feita para"} +${call.peer} em ${quando} (resumo da IA).`,
        p.responsavel ? `Responsável citado: ${p.responsavel}.` : "",
        p.prazo ? `Prazo citado: ${p.prazo}.` : "",
      ].filter(Boolean).join("\n");
      const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
      await db.insert(schema.tasks).values({ id, content: p.descricao, description: descricao, projectId: null, ownerPersonId: me, sectionId: null, assigneePersonId: null, dueDate: hoje, createdBy: me });
      return { id, jaExistia: false };
    });
  });

/** "Resumir com IA": só o dono pede; aí o worker manda o áudio à OpenAI (nada vai sozinho). */
export const pedirResumoChamada = createServerFn({ method: "POST" })
  .validator(z.object({ callId: z.uuid() }))
  .handler(async ({ data }) => {
    const me = await pessoa();
    return withPerson(getPool(), me, async db => {
      const r = await db.execute<{ ok: boolean }>(sql`select app.pedir_resumo_chamada(${data.callId}::uuid) as ok`);
      if (!r.rows[0]?.ok) throw new ErroParaTela("Só o dono pode pedir o resumo, e a gravação precisa estar disponível.");
      return { ok: true };
    });
  });

/** Ligações com o contato de uma conversa (aba Ligações da conversa): as que a pessoa vê (RLS de whatsapp_calls). */
export const ligacoesDaConversa = createServerFn({ method: "GET" })
  .validator(z.object({ chatId: z.uuid() }))
  .handler(async ({ data }) => {
    const me = await pessoa();
    return withPerson(getPool(), me, async db => {
      const [conversa] = await db
        .select({ numberId: schema.whatsappChats.numberId, telefone: schema.whatsappChats.phone, jid: schema.whatsappChats.jid, grupo: schema.whatsappChats.isGroup, nome: schema.whatsappChats.name })
        .from(schema.whatsappChats).where(eq(schema.whatsappChats.id, data.chatId));
      const tel = conversa && !conversa.grupo ? (conversa.telefone ?? conversa.jid.match(/^(\d{8,15})@s\.whatsapp\.net$/)?.[1] ?? null) : null;
      if (!conversa || !tel) return { ligacoes: [] as LigacaoNaLista[], pessoas: [] as { id: string; nome: string }[] };
      const linhas = await db.select().from(schema.whatsappCalls)
        .where(and(eq(schema.whatsappCalls.numberId, conversa.numberId), eq(schema.whatsappCalls.peer, tel)))
        .orderBy(desc(schema.whatsappCalls.createdAt)).limit(200);
      const shares = linhas.length ? await db.select().from(schema.whatsappCallShares).where(inArray(schema.whatsappCallShares.callId, linhas.map(l => l.id))) : [];
      const pessoas = linhas.some(l => l.ownerPersonId === me) ? (await db.execute<{ id: string; nome: string }>(sql`select * from app.pessoas_para_compartilhar_gravacao()`)).rows : [];
      const contatos: Contatos = { [`${conversa.numberId}:${tel}`]: { nome: conversa.nome, chatId: data.chatId } };
      return { ligacoes: linhas.map(c => itemDaLista(c, me, shares, contatos)), pessoas };
    });
  });

/** Transcrição de uma ligação (0062): quem ouve a gravação (dono ou compartilhada), pela RLS. */
export const transcricaoDaChamada = createServerFn({ method: "GET" })
  .validator(z.object({ callId: z.uuid() }))
  .handler(async ({ data }) => {
    const me = await pessoa();
    const [c] = await withPerson(getPool(), me, db => db.select({ t: schema.whatsappCalls.transcript }).from(schema.whatsappCalls).where(eq(schema.whatsappCalls.id, data.callId)));
    if (!c) throw new ErroParaTela("Você não tem acesso a esta ligação.");
    return { texto: c.t };
  });
