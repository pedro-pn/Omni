import { formatarTelefone, missoesNoNomeDoGrupo, tituloMissao } from "@omni/core";
import { schema, withPerson, type Db } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { getEnv } from "../server/env.ts";
import { personIdFromRequest } from "../server/session.ts";
import { enviarPeloWhatsApp } from "../server/whatsapp-envio.ts";
import { enderecoDoProxy } from "../server/email-imagem.ts";
import { previaDoEndereco, type PreviaDeLink } from "../server/link-previa.ts";
import { ErroParaTela } from "./erros.ts";
import { resumoDaChamada } from "./chamadas-fns.ts";
import { exigirModulo } from "../server/modulos.ts";

/**
 * Conversas do WhatsApp (Fase 7): o que chegou pelo webhook da Evolution (e o
 * histórico dos grupos escolhidos), só das conversas que a pessoa vê — dos
 * números que ela acompanha ou dos grupos ligados a missões cujo Interno ela
 * vê (RLS, migrations 0027 e 0028). Responder exige ver o número; o envio
 * segue WHATSAPP_ENVIO (em ensaio fica registrado e não sai).
 */

export type ConversaResumo = {
  id: string;
  numero: { id: string; rotulo: string };
  grupo: boolean;
  nome: string;
  telefone: string | null;
  /** Endereço da foto pelo servidor do Omni (muda quando a foto muda); null sem foto. */
  foto: string | null;
  ultimaEm: string | null;
  previa: string | null;
  podeResponder: boolean;
  podeLigar: boolean;
  missoes: { id: string; titulo: string }[];
  /** Missões citadas no nome do grupo, ainda não ligadas nem recusadas (só para quem pode ligar). */
  sugestoes: { id: string; titulo: string }[];
  /** Concluída por esta pessoa e sem mensagem nova do contato desde então (inbox zero). */
  concluida: boolean;
  /** Fixada no topo da lista desta pessoa (0087): quando fixou; null se não. */
  fixadaEm: string | null;
  /** Mensagens do contato depois da última leitura desta pessoa (até 99; 0075). */
  naoLidas: number;
  /** Marcada como não lida pela pessoa (mostra o ponto mesmo sem mensagem nova). */
  marcadaNaoLida: boolean;
  /** Até quando a pessoa leu (null: nunca abriu). */
  lidaAte: string | null;
};

export type MensagemWhatsApp = {
  id: string;
  deMim: boolean;
  autor: string | null;
  /** Quem enviou, no grupo (JID do WhatsApp): cor do nome e foto, como no WhatsApp Web. */
  autorId?: string | null;
  tipo: "texto" | "imagem" | "video" | "audio" | "documento" | "figurinha" | "localizacao" | "contato" | "outro";
  texto: string | null;
  arquivo: string | null;
  em: string;
  status: "enviada" | "entregue" | "lida" | "erro" | null;
  /** Escrita no Omni em modo de ensaio: registrada, não saiu. */
  ensaio?: boolean;
  /** Saindo agora (só na tela, até o servidor confirmar). */
  pendente?: boolean;
  /** Resposta: a mensagem citada (id, trecho e quem escreveu, JID). */
  citada?: { waId: string; texto: string | null; autorId: string | null } | null;
  encaminhada?: boolean;
  editada?: boolean;
  /** Apagada para todos (o conteúdo já saiu do Omni). */
  apagada?: boolean;
  /** Id da mensagem no WhatsApp (junta o servidor com o histórico do aparelho sem repetir). */
  waId?: string;
  /** Endereço do arquivo, quando não é o padrão (mensagem do histórico do aparelho). */
  midia?: string;
  /** Ligação com este contato (só para o dono da linha ou com quem a gravação foi compartilhada). */
  chamada?: { id: string; direcao: "entrada" | "saida"; atendida: boolean; segundos: number | null; gravacao: boolean; minha: boolean } & ReturnType<typeof resumoDaChamada>;
};

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

async function resumir(db: Db, filtro: ReturnType<typeof and> | undefined, limite = 300): Promise<ConversaResumo[]> {
  const c = schema.whatsappChats;
  const n = schema.whatsappNumbers;
  const brutas = await db
    .select({ c, numero: { id: n.id, rotulo: n.label } })
    .from(c)
    .innerJoin(n, eq(n.id, c.numberId))
    .where(and(isNotNull(c.lastMessageAt), filtro))
    .orderBy(desc(c.lastMessageAt))
    .limit(limite);
  // Responder e ligar dependem só do número: uma vez por número, não por conversa (0072).
  const numeros = [...new Set(brutas.map((l) => l.numero.id))];
  const permissoes = new Map(
    numeros.length
      ? (
          await db.execute<{ id: string; responder: boolean; ligar: boolean }>(sql`
            SELECT id, app.ve_numero_whatsapp(id) AS responder, app.pode_usar_linha_chamada(id) AS ligar
              FROM unnest(${`{${numeros.join(",")}}`}::uuid[]) AS id`)
        ).rows.map((r) => [r.id, r])
      : [],
  );
  const linhas = brutas.map((l) => ({ ...l, podeResponder: permissoes.get(l.numero.id)?.responder ?? false, podeLigar: permissoes.get(l.numero.id)?.ligar ?? false }));
  const ids = linhas.map((l) => l.c.id);
  const ligacoes = ids.length
    ? await db
        .select({ chatId: schema.whatsappChatMissions.chatId, id: schema.missions.id, code: schema.missions.code, cliente: schema.missions.clientName })
        .from(schema.whatsappChatMissions)
        .innerJoin(schema.missions, eq(schema.missions.id, schema.whatsappChatMissions.missionId))
        .where(inArray(schema.whatsappChatMissions.chatId, ids))
    : [];
  // Sugestão grupo ↔ missão pelo número da missão no nome do grupo.
  const comNome = linhas.filter((l) => l.podeResponder && l.c.isGroup && l.c.name && /\d{4}/.test(l.c.name));
  const ativas = comNome.length
    ? await db.select({ id: schema.missions.id, code: schema.missions.code, cliente: schema.missions.clientName }).from(schema.missions).where(eq(schema.missions.isActive, true))
    : [];
  const recusadas = comNome.length
    ? new Set(
        (
          await db
            .select({ chatId: schema.whatsappLinkDismissals.chatId, missionId: schema.whatsappLinkDismissals.missionId })
            .from(schema.whatsappLinkDismissals)
            .where(inArray(schema.whatsappLinkDismissals.chatId, comNome.map((l) => l.c.id)))
        ).map((r) => `${r.chatId}:${r.missionId}`),
      )
    : new Set<string>();
  // Fixadas no topo da lista (0087, RLS: só as desta pessoa).
  const fixadas = new Map((await db.select().from(schema.whatsappChatPins)).map((f) => [f.chatId, f.pinnedAt.toISOString()]));
  // Inbox zero: concluídas por esta pessoa (RLS: só as dela) que não receberam mensagem do contato depois.
  const concluidas = ids.length
    ? new Set(
        (
          await db.execute<{ chat_id: string }>(sql`
            SELECT cc.chat_id FROM whatsapp_chat_concluded cc
             WHERE cc.chat_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
               AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.chat_id = cc.chat_id AND NOT m.from_me AND m.sent_at > cc.concluded_at)`)
        ).rows.map((r) => r.chat_id),
      )
    : new Set<string>();
  // Lida / não lida (0075): leitura da pessoa e, só nas conversas com algo depois dela, a contagem.
  const leituras = ids.length
    ? new Map(
        (await db.select().from(schema.whatsappChatReads).where(inArray(schema.whatsappChatReads.chatId, ids))).map((l) => [l.chatId, l]),
      )
    : new Map<string, typeof schema.whatsappChatReads.$inferSelect>();
  const comNovas = linhas.filter((l) => l.c.lastMessageAt && (!leituras.get(l.c.id) || l.c.lastMessageAt > leituras.get(l.c.id)!.readAt)).map((l) => l.c.id);
  const contagens = comNovas.length
    ? new Map(
        (
          await db.execute<{ chat_id: string; n: number }>(sql`
            SELECT c.id AS chat_id, (SELECT count(*)::int FROM (
                     SELECT 1 FROM whatsapp_messages m
                      WHERE m.chat_id = c.id AND NOT m.from_me
                        AND m.sent_at > coalesce((SELECT r.read_at FROM whatsapp_chat_reads r WHERE r.chat_id = c.id AND r.person_id = app.current_person_id()), '-infinity')
                      LIMIT 99) x) AS n
              FROM unnest(${`{${comNovas.join(",")}}`}::uuid[]) AS c(id)`)
        ).rows.map((r) => [r.chat_id, r.n]),
      )
    : new Map<string, number>();
  return linhas.map(({ c: x, numero, podeResponder, podeLigar }) => ({
    id: x.id,
    numero,
    grupo: x.isGroup,
    nome: x.name ?? formatarTelefone(x.phone) ?? (x.isGroup ? "Grupo" : "Contato"),
    telefone: x.phone,
    foto: x.photoUrl ? `/api/whatsapp/foto/${x.id}?v=${x.profileSyncAt?.getTime() ?? 0}` : null,
    ultimaEm: x.lastMessageAt?.toISOString() ?? null,
    previa: x.lastPreview,
    podeResponder: Boolean(podeResponder),
    podeLigar: Boolean(podeLigar),
    missoes: ligacoes.filter((l) => l.chatId === x.id).map((l) => ({ id: l.id, titulo: tituloMissao(l.code, l.cliente) })),
    sugestoes:
      podeResponder && x.isGroup
        ? missoesNoNomeDoGrupo(x.name, ativas)
            .filter((m) => !ligacoes.some((l) => l.chatId === x.id && l.id === m.id) && !recusadas.has(`${x.id}:${m.id}`))
            .map((m) => ({ id: m.id, titulo: tituloMissao(m.code, m.cliente) }))
        : [],
    concluida: concluidas.has(x.id),
    fixadaEm: fixadas.get(x.id) ?? null,
    naoLidas: contagens.get(x.id) ?? 0,
    marcadaNaoLida: leituras.get(x.id)?.markedUnread ?? false,
    lidaAte: leituras.get(x.id)?.readAt.toISOString() ?? null,
  }));
}

/** Marca a conversa como lida (agora) ou não lida, para esta pessoa (0075). Nada vai para o WhatsApp. */
export const marcarConversaLida = createServerFn({ method: "POST" })
  .validator(z.object({ chatId: z.uuid(), lida: z.boolean() }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    const t = schema.whatsappChatReads;
    await withPerson(getPool(), personId, (db) =>
      data.lida
        ? db.insert(t).values({ personId, chatId: data.chatId, readAt: new Date(), markedUnread: false }).onConflictDoUpdate({ target: [t.personId, t.chatId], set: { readAt: new Date(), markedUnread: false } })
        : db.insert(t).values({ personId, chatId: data.chatId, markedUnread: true }).onConflictDoUpdate({ target: [t.personId, t.chatId], set: { markedUnread: true } }),
    ).catch(() => {
      throw new ErroParaTela("Não foi possível marcar esta conversa.");
    });
    return { ok: true };
  });

export const listarConversas = createServerFn({ method: "GET" }).handler(async (): Promise<ConversaResumo[]> => {
  const personId = await pessoa();
  await exigirModulo(personId, "whatsapp");
  // Todas as conversas do histórico (o celular manda centenas): até 2.000, as mais recentes primeiro.
  return withPerson(getPool(), personId, (db) => resumir(db, undefined, 2000));
});

/** Conversas (grupos) ligadas a uma missão, para a aba WhatsApp da missão. */
export const conversasDaMissao = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<ConversaResumo[]> => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, (db) =>
      resumir(
        db,
        and(
          inArray(
            schema.whatsappChats.id,
            db.select({ id: schema.whatsappChatMissions.chatId }).from(schema.whatsappChatMissions).where(eq(schema.whatsappChatMissions.missionId, data.missionId)),
          ),
        ),
        50,
      ),
    );
  });

export const mensagensDaConversa = createServerFn({ method: "GET" })
  .validator(z.object({ chatId: z.uuid() }))
  .handler(async ({ data }): Promise<MensagemWhatsApp[]> => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const m = schema.whatsappMessages;
      // As 300 mais recentes, em ordem de envio.
      const linhas = await db.select().from(m).where(eq(m.chatId, data.chatId)).orderBy(desc(m.sentAt)).limit(300);
      const ensaios = await db
        .select()
        .from(schema.whatsappOutbox)
        .where(and(eq(schema.whatsappOutbox.chatId, data.chatId), eq(schema.whatsappOutbox.mode, "ensaio")))
        .orderBy(desc(schema.whatsappOutbox.createdAt))
        .limit(50);
      const todas: MensagemWhatsApp[] = [
        ...linhas.map((x) => ({
          id: x.id,
          waId: x.waId,
          deMim: x.fromMe,
          autor: x.fromMe ? null : (x.authorName ?? formatarTelefone(x.authorJid?.match(/^(\d{8,15})@s\.whatsapp\.net$/)?.[1] ?? null)),
          autorId: x.fromMe ? null : x.authorJid,
          citada: x.quotedWaId ? { waId: x.quotedWaId, texto: x.quotedBody, autorId: x.quotedAuthor } : null,
          encaminhada: x.forwarded,
          editada: Boolean(x.editedAt),
          apagada: Boolean(x.deletedAt),
          tipo: x.kind,
          texto: x.body,
          arquivo: x.fileName,
          em: x.sentAt.toISOString(),
          status: x.status,
        })),
        ...ensaios.map((x) => ({
          id: x.id,
          deMim: true,
          autor: null,
          tipo: x.fileName ? ("documento" as const) : ("texto" as const),
          texto: x.body || null,
          arquivo: x.fileName,
          em: x.createdAt.toISOString(),
          status: null,
          ensaio: true,
        })),
      ];
      // Ligações com este contato (RLS de whatsapp_calls: dono da linha ou gravação compartilhada).
      const [conversa] = await db
        .select({ numberId: schema.whatsappChats.numberId, telefone: schema.whatsappChats.phone, jid: schema.whatsappChats.jid, grupo: schema.whatsappChats.isGroup })
        .from(schema.whatsappChats)
        .where(eq(schema.whatsappChats.id, data.chatId));
      const tel = conversa && !conversa.grupo ? (conversa.telefone ?? conversa.jid.match(/^(\d{8,15})@s\.whatsapp\.net$/)?.[1] ?? null) : null;
      if (conversa && tel) {
        const ligacoes = await db
          .select()
          .from(schema.whatsappCalls)
          .where(and(eq(schema.whatsappCalls.numberId, conversa.numberId), eq(schema.whatsappCalls.peer, tel), isNull(schema.whatsappCalls.deletedAt)))
          .orderBy(desc(schema.whatsappCalls.createdAt))
          .limit(50);
        for (const l of ligacoes) {
          if (l.state !== "encerrada") continue;
          todas.push({
            id: `chamada-${l.id}`,
            deMim: l.direction === "saida",
            autor: null,
            tipo: "texto",
            texto: null,
            arquivo: null,
            em: l.createdAt.toISOString(),
            status: null,
            chamada: {
              id: l.id,
              direcao: l.direction,
              atendida: Boolean(l.startedAt),
              segundos: l.startedAt && l.endedAt ? Math.max(0, Math.round((l.endedAt.getTime() - l.startedAt.getTime()) / 1000)) : null,
              gravacao: l.audio && l.expiresAt > new Date(),
              minha: l.ownerPersonId === personId,
              ...resumoDaChamada(l),
            },
          });
        }
      }
      return todas.sort((a, b) => a.em.localeCompare(b.em));
    });
  });

export const ligarConversaMissao = createServerFn({ method: "POST" })
  .validator(z.object({ chatId: z.uuid(), missionId: z.uuid(), ligar: z.boolean() }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const l = schema.whatsappChatMissions;
      if (!data.ligar) {
        const tiradas = await db.delete(l).where(and(eq(l.chatId, data.chatId), eq(l.missionId, data.missionId))).returning({ chatId: l.chatId });
        if (!tiradas.length) throw new ErroParaTela("Só quem acompanha o número pode desligar a conversa da missão.");
        return { ok: true };
      }
      try {
        await db.insert(l).values({ chatId: data.chatId, missionId: data.missionId, linkedBy: personId }).onConflictDoNothing();
      } catch {
        throw new ErroParaTela("Só quem acompanha o número pode ligar a conversa a uma missão.");
      }
      await db.insert(schema.auditLog).values({ actorPersonId: personId, action: "whatsapp.conversa_ligada", entityType: "whatsapp_chat", entityId: data.chatId, metadata: { missionId: data.missionId } });
      return { ok: true };
    });
  });

export const enviarMensagemWhatsApp = createServerFn({ method: "POST" })
  .validator(
    z.object({
      chatId: z.uuid(),
      texto: z.string().trim().min(1, "Escreva a mensagem.").max(4096, "Mensagem longa demais."),
      // Resposta: a mensagem citada.
      citada: z.object({ waId: z.string().min(1).max(128), deMim: z.boolean(), autorId: z.string().max(200).nullable().optional(), texto: z.string().max(300).nullable().optional() }).optional(),
    }),
  )
  .handler(async ({ data }): Promise<{ modo: "ensaio" | "real" }> => enviarPeloWhatsApp(await pessoa(), data.chatId, data.texto, undefined, { citada: data.citada }));

/** Modo de envio deste ambiente (para a tela avisar quando é ensaio). */
export const modoEnvioWhatsApp = createServerFn({ method: "GET" }).handler(async () => {
  await pessoa();
  return { modo: getEnv().WHATSAPP_ENVIO };
});

/** "Não é desta missão": a sugestão pelo nome do grupo não volta. */
/** Concluir (inbox zero): a conversa sai da lista desta pessoa até chegar mensagem nova do contato. */
/** Dá um nome ao contato (só o dono do número, só conversa com pessoa; 0057). */
export const renomearContato = createServerFn({ method: "POST" })
  .validator(z.object({ chatId: z.uuid(), nome: z.string().trim().min(1, "Escreva um nome.").max(120) }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    const [r] = await withPerson(getPool(), personId, (db) =>
      db.execute<{ ok: boolean }>(sql`SELECT app.whatsapp_renomear_contato(${data.chatId}::uuid, ${data.nome}) AS ok`),
    ).then((x) => x.rows);
    if (!r?.ok) throw new ErroParaTela("Só o dono do número dá nome aos contatos dele.");
    return { ok: true };
  });

export const concluirConversa = createServerFn({ method: "POST" })
  .validator(z.object({ chatId: z.uuid(), concluir: z.boolean() }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const t = schema.whatsappChatConcluded;
      if (!data.concluir) {
        await db.delete(t).where(and(eq(t.personId, personId), eq(t.chatId, data.chatId)));
        return { ok: true };
      }
      try {
        await db
          .insert(t)
          .values({ personId, chatId: data.chatId })
          .onConflictDoUpdate({ target: [t.personId, t.chatId], set: { concludedAt: sql`now()` } });
      } catch {
        throw new ErroParaTela("Conversa não encontrada.");
      }
      return { ok: true };
    });
  });

export const recusarSugestaoMissao = createServerFn({ method: "POST" })
  .validator(z.object({ chatId: z.uuid(), missionId: z.uuid() }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      try {
        await db.insert(schema.whatsappLinkDismissals).values({ chatId: data.chatId, missionId: data.missionId, dismissedBy: personId }).onConflictDoNothing();
      } catch {
        throw new ErroParaTela("Só quem acompanha o número pode responder à sugestão.");
      }
      return { ok: true };
    });
  });

/** Prévia de um link citado numa mensagem (título, descrição, imagem pelo proxy assinado). */
export const previaDeLink = createServerFn({ method: "GET" })
  .validator(z.object({ url: z.url({ protocol: /^https?$/ }).max(2000) }))
  .handler(async ({ data }): Promise<PreviaDeLink | null> => {
    await pessoa();
    const p = await previaDoEndereco(data.url);
    return p ? { ...p, imagem: p.imagem ? enderecoDoProxy(getEnv().AUTH_SECRET, p.imagem) : null } : null;
  });

export type DetalhesDaConversa = {
  /** Reações por mensagem (waId): cada emoji com quantos e se uma é minha. */
  reacoes: Record<string, Array<{ emoji: string; quantos: number; minha: boolean; quem: string[] }>>;
  favoritas: string[];
  /** Apagadas só para mim. */
  ocultas: string[];
  /** Fixadas no topo da conversa (mais recente primeiro). */
  fixadas: string[];
};

/** Reações, favoritas, apagadas para mim e fixadas de uma conversa (valem também para o histórico do aparelho). */
export const detalhesDaConversa = createServerFn({ method: "GET" })
  .validator(z.object({ chatId: z.uuid() }))
  .handler(async ({ data }): Promise<DetalhesDaConversa> => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const reacoes = await db.select().from(schema.whatsappReactions).where(eq(schema.whatsappReactions.chatId, data.chatId));
      const flags = await db
        .select()
        .from(schema.whatsappMessageFlags)
        .where(and(eq(schema.whatsappMessageFlags.chatId, data.chatId), eq(schema.whatsappMessageFlags.personId, personId)));
      const fixadas = await db
        .select({ waId: schema.whatsappPinnedMessages.waId })
        .from(schema.whatsappPinnedMessages)
        .where(eq(schema.whatsappPinnedMessages.chatId, data.chatId))
        .orderBy(desc(schema.whatsappPinnedMessages.pinnedAt));
      const porMensagem: DetalhesDaConversa["reacoes"] = {};
      for (const r of reacoes) {
        const lista = (porMensagem[r.waId] ??= []);
        const e = lista.find((x) => x.emoji === r.emoji) ?? (lista.push({ emoji: r.emoji, quantos: 0, minha: false, quem: [] }), lista.at(-1)!);
        e.quantos += 1;
        if (r.reactor === "eu") e.minha = true;
        e.quem.push(r.reactor === "eu" ? "Você" : (r.reactorName ?? formatarTelefone(r.reactor.match(/^(\d{8,15})@s\.whatsapp\.net$/)?.[1] ?? null) ?? "Contato"));
      }
      return {
        reacoes: porMensagem,
        favoritas: flags.filter((f) => f.starred).map((f) => f.waId),
        ocultas: flags.filter((f) => f.hidden).map((f) => f.waId),
        fixadas: fixadas.map((f) => f.waId),
      };
    });
  });

