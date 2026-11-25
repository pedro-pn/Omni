import { fluxo, type CampoResposta } from "@omni/core";
import { schema, withPerson, type Canal, type Db } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";
import { lerNovidadesDasMissoes, type NovidadeDaMissao } from "../server/novidades.ts";

export type { NovidadeDaMissao };

/**
 * Canais Interno e Gerencial das missões. Quem vê e quem gerencia é decidido
 * no banco (migration 0005: app.canal_desde / app.pode_gerenciar_canal); aqui só
 * há leitura, gravação, mensagens de sistema e auditoria.
 */

const canalSchema = z.enum(["interno", "gerencial"]);
const alvo = z.object({ missionId: z.uuid(), channel: canalSchema });

export class CanalError extends ErroParaTela {}

async function comoPessoa<T>(fn: (db: Db, meuId: string) => Promise<T>): Promise<T> {
  const meuId = await personIdFromRequest(getRequest());
  if (!meuId) throw new CanalError("Sessão expirada. Entre de novo.");
  try {
    return await withPerson(getPool(), meuId, (db) => fn(db, meuId));
  } catch (error) {
    if (error instanceof CanalError) throw error;
    const causa = String((error as Error & { cause?: Error }).cause?.message ?? (error as Error).message);
    if (/row-level security|permission denied/.test(causa)) throw new CanalError("Você não tem acesso a este canal.");
    throw error;
  }
}

async function acesso(db: Db, missionId: string, channel: Canal) {
  const { rows } = await db.execute<{ desde: string | null; gerencia: boolean }>(
    sql`SELECT app.canal_desde(${missionId}::uuid, ${channel}) AS desde, app.pode_gerenciar_canal(${missionId}::uuid, ${channel}) AS gerencia`,
  );
  return { acesso: rows[0]?.desde != null, podeGerenciar: Boolean(rows[0]?.gerencia) };
}

// ---------------------------------------------------------------- canais e não lidas

export type InfoCanal = { channel: Canal; acesso: boolean; podeGerenciar: boolean; naoLidas: number };

export const getCanais = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<InfoCanal[]> =>
    comoPessoa(async (db) => {
      const naoLidas = await contarNaoLidas(db, [data.missionId]);
      const out: InfoCanal[] = [];
      for (const channel of schema.CANAIS) {
        const a = await acesso(db, data.missionId, channel);
        out.push({ channel, ...a, naoLidas: naoLidas.get(`${data.missionId}:${channel}`) ?? 0 });
      }
      return out;
    }),
  );

/**
 * Mensagens de outras pessoas depois da última leitura, por missão ativa e canal. O acesso
 * é o da política dos canais (app.canal_desde), calculado uma vez por canal (0072).
 */
async function contarNaoLidas(db: Db, missionIds?: string[]): Promise<Map<string, number>> {
  const { rows } = await db.execute<{ mission_id: string; channel: Canal; n: number }>(sql`
    SELECT mission_id, channel, (de_pessoas + da_ia)::int AS n FROM app.novidades_dos_canais()`);
  const filtro = missionIds ? new Set(missionIds) : null;
  return new Map(rows.filter((r) => !filtro || filtro.has(r.mission_id)).map((r) => [`${r.mission_id}:${r.channel}`, r.n]));
}

export const getNaoLidas = createServerFn({ method: "GET" }).handler(
  async (): Promise<Record<string, { interno: number; gerencial: number }>> =>
    comoPessoa(async (db) => {
      const out: Record<string, { interno: number; gerencial: number }> = {};
      for (const [chave, n] of await contarNaoLidas(db)) {
        const [missionId, channel] = chave.split(":") as [string, Canal];
        out[missionId] ??= { interno: 0, gerencial: 0 };
        out[missionId][channel] = n;
      }
      return out;
    }),
);

export const novidadesDasMissoes = createServerFn({ method: "GET" }).handler(async (): Promise<NovidadeDaMissao[]> => comoPessoa((db) => lerNovidadesDasMissoes(db)));

// ---------------------------------------------------------------- mensagens

export type PerguntaIA = {
  id: string;
  flow: string;
  status: "agendada" | "enviada" | "respondida" | "cancelada";
  opcoes: Array<{
    id: string;
    rotulo: string;
    pede: CampoResposta[];
    rotulos: Partial<Record<CampoResposta, string>>;
    abreDesvio: boolean;
    criaTarefa: boolean;
    registraDescarga: boolean;
  }>;
  resposta: {
    opcao: string;
    rotulo: string;
    nova_data?: string;
    motivo?: string;
    detalhe?: string;
    tarefa?: { id: string; titulo: string };
  } | null;
  respondidaPor: string | null;
  respondidaEm: string | null;
  desvio: { status: "pendente" | "enviado" | "simulado" | "ensaio" | "falhou"; numero: string | null } | null;
  /** Confirmação de descarga enviada ao filtroAPP (fluxo "descarga"). */
  descarga: { status: "pendente" | "enviado" | "simulado" | "ensaio" | "falhou" } | null;
};

export type Mensagem = {
  id: string;
  kind: "texto" | "sistema" | "ia";
  body: string;
  createdAt: string;
  autor: { id: string; nome: string } | null;
  pergunta: PerguntaIA | null;
  /** Cartão "entendi assim" de um alerta pedido à IA (migration 0031). */
  alerta?: { id: string; status: "rascunho" | "ativo" | "pausado" | "cancelado"; podeMudar: boolean } | null;
  /** Disparo de um alerta, com a resposta quando houver. */
  disparo?: { id: string; resposta: { opcao: "nao_veio" | "cobrar" | "veio"; exemplo: string | null } | null; respondidaPor: string | null } | null;
  /** Arquivos da mensagem (0063), abertos por /api/canais/arquivo/<id>. */
  arquivos?: { id: string; nome: string; tipo: string; tamanho: number }[];
};

const respondente = alias(schema.people, "respondente");
const respondenteAlerta = alias(schema.people, "respondente_alerta");

async function lerMensagens(db: Db, missionId: string, channel: Canal, meuId: string, souDiretoria: boolean): Promise<Mensagem[]> {
  const rows = await db
    .select({
      id: schema.missionMessages.id,
      kind: schema.missionMessages.kind,
      body: schema.missionMessages.body,
      createdAt: schema.missionMessages.createdAt,
      autorId: schema.people.id,
      autorNome: schema.people.displayName,
      pergunta: schema.aiQuestions,
      respondente: respondente.displayName,
      desvioStatus: schema.aiDeviations.status,
      desvioNumero: schema.aiDeviations.filtroappNumber,
      descargaStatus: schema.aiUnloadings.status,
      alerta: { id: schema.aiAlerts.id, status: schema.aiAlerts.status, criador: schema.aiAlerts.createdBy },
      disparo: { id: schema.aiAlertFires.id, resposta: schema.aiAlertFires.answer },
      respondenteAlerta: respondenteAlerta.displayName,
    })
    .from(schema.missionMessages)
    .leftJoin(schema.people, eq(schema.people.id, schema.missionMessages.authorPersonId))
    .leftJoin(schema.aiQuestions, eq(schema.aiQuestions.messageId, schema.missionMessages.id))
    .leftJoin(respondente, eq(respondente.id, schema.aiQuestions.answeredBy))
    .leftJoin(schema.aiDeviations, eq(schema.aiDeviations.questionId, schema.aiQuestions.id))
    .leftJoin(schema.aiUnloadings, eq(schema.aiUnloadings.questionId, schema.aiQuestions.id))
    .leftJoin(schema.aiAlerts, eq(schema.aiAlerts.id, schema.missionMessages.alertId))
    .leftJoin(schema.aiAlertFires, eq(schema.aiAlertFires.id, schema.missionMessages.alertFireId))
    .leftJoin(respondenteAlerta, eq(respondenteAlerta.id, schema.aiAlertFires.answeredBy))
    .where(and(eq(schema.missionMessages.missionId, missionId), eq(schema.missionMessages.channel, channel)))
    .orderBy(desc(schema.missionMessages.createdAt))
    .limit(300);
  // Arquivos das mensagens (RLS: os de mensagens que a pessoa vê).
  const arquivos = rows.length
    ? await db
        .select({ id: schema.missionMessageFiles.id, messageId: schema.missionMessageFiles.messageId, nome: schema.missionMessageFiles.name, tipo: schema.missionMessageFiles.mime, tamanho: schema.missionMessageFiles.size })
        .from(schema.missionMessageFiles)
        .where(inArray(schema.missionMessageFiles.messageId, rows.map((r) => r.id)))
        .orderBy(asc(schema.missionMessageFiles.createdAt))
    : [];
  return rows.reverse().map((r) => ({
    arquivos: arquivos.filter((a) => a.messageId === r.id).map(({ messageId: _m, ...a }) => a),
    id: r.id,
    kind: r.kind,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
    autor: r.autorId ? { id: r.autorId, nome: r.autorNome ?? "" } : null,
    pergunta: r.pergunta ? perguntaParaTela(r.pergunta, r.respondente, r.desvioStatus, r.desvioNumero, r.descargaStatus) : null,
    alerta: r.alerta?.id ? { id: r.alerta.id, status: r.alerta.status!, podeMudar: r.alerta.criador === meuId || souDiretoria } : null,
    disparo: r.disparo?.id ? { id: r.disparo.id, resposta: r.disparo.resposta ?? null, respondidaPor: r.respondenteAlerta ?? null } : null,
  }));
}

function perguntaParaTela(
  q: typeof schema.aiQuestions.$inferSelect,
  respondidaPor: string | null,
  desvioStatus: NonNullable<PerguntaIA["desvio"]>["status"] | null,
  desvioNumero: string | null,
  descargaStatus: NonNullable<PerguntaIA["descarga"]>["status"] | null = null,
): PerguntaIA {
  const definicao = fluxo(q.flow);
  return {
    id: q.id,
    flow: q.flow,
    status: q.status,
    opcoes: (definicao?.opcoes ?? []).map((o) => ({
      id: o.id,
      rotulo: o.rotulo,
      pede: o.pede ?? [],
      rotulos: o.rotulos ?? {},
      abreDesvio: Boolean(o.desvio),
      criaTarefa: Boolean(o.tarefa),
      registraDescarga: Boolean(o.descarga),
    })),
    resposta: (q.answer as PerguntaIA["resposta"]) ?? null,
    respondidaPor,
    respondidaEm: q.answeredAt?.toISOString() ?? null,
    desvio: desvioStatus ? { status: desvioStatus, numero: desvioNumero } : null,
    descarga: descargaStatus ? { status: descargaStatus } : null,
  };
}

export const listMensagens = createServerFn({ method: "GET" })
  .validator(alvo)
  .handler(async ({ data }) =>
    comoPessoa(async (db, meuId) => {
      const [d] = (await db.execute<{ ok: boolean }>(sql`SELECT app.has_profile('diretoria') AS ok`)).rows;
      return lerMensagens(db, data.missionId, data.channel, meuId, Boolean(d?.ok));
    }),
  );

export const marcarLido = createServerFn({ method: "POST" })
  .validator(alvo)
  .handler(async ({ data }) =>
    comoPessoa(async (db, meuId) => {
      const agora = new Date();
      await db
        .insert(schema.missionReads)
        .values({ ...data, personId: meuId, lastReadAt: agora })
        .onConflictDoUpdate({
          target: [schema.missionReads.missionId, schema.missionReads.channel, schema.missionReads.personId],
          set: { lastReadAt: agora },
        });
      return { ok: true };
    }),
  );

export const enviarMensagem = createServerFn({ method: "POST" })
  .validator(alvo.extend({ body: z.string().trim().min(1).max(8000) }))
  .handler(async ({ data }) =>
    comoPessoa(async (db, meuId) => {
      const [m] = await db
        .insert(schema.missionMessages)
        .values({ missionId: data.missionId, channel: data.channel, authorPersonId: meuId, body: data.body })
        .returning({ id: schema.missionMessages.id });
      return { id: m!.id };
    }),
  );

// ---------------------------------------------------------------- membros

export type Membro = {
  personId: string;
  nome: string;
  email: string;
  origem: "filtroapp" | "adicionado";
  papel: string | null;
  historico: "todo" | "desde";
  desde: string | null;
};

export const listMembros = createServerFn({ method: "GET" })
  .validator(alvo)
  .handler(async ({ data }): Promise<Membro[]> =>
    comoPessoa(async (db) => {
      const explicitos = await db
        .select({
          personId: schema.missionMembers.personId,
          nome: schema.people.displayName,
          email: schema.people.email,
          historySince: schema.missionMembers.historySince,
        })
        .from(schema.missionMembers)
        .innerJoin(schema.people, eq(schema.people.id, schema.missionMembers.personId))
        .where(
          and(
            eq(schema.missionMembers.missionId, data.missionId),
            eq(schema.missionMembers.channel, data.channel),
            isNull(schema.missionMembers.removedAt),
            eq(schema.people.active, true),
          ),
        )
        .orderBy(asc(schema.people.displayName));

      const implicitos =
        data.channel === "interno"
          ? await db
              .select({
                personId: schema.people.id,
                nome: schema.people.displayName,
                email: schema.people.email,
                role: schema.missionResponsibles.role,
              })
              .from(schema.missionResponsibles)
              .innerJoin(schema.people, sql`${schema.people.email} = ${schema.missionResponsibles.email} AND ${schema.people.active}`)
              .where(
                and(
                  eq(schema.missionResponsibles.missionId, data.missionId),
                  inArray(schema.missionResponsibles.role, ["LEADER", "PLANNER"]),
                ),
              )
          : [];

      const vistos = new Set<string>();
      const out: Membro[] = [];
      for (const i of implicitos) {
        if (vistos.has(i.personId)) continue;
        vistos.add(i.personId);
        out.push({
          personId: i.personId,
          nome: i.nome,
          email: i.email,
          origem: "filtroapp",
          papel: i.role === "LEADER" ? "Líder de projetos" : "Gestor de contrato",
          historico: "todo",
          desde: null,
        });
      }
      for (const e of explicitos) {
        if (vistos.has(e.personId)) continue;
        vistos.add(e.personId);
        out.push({
          personId: e.personId,
          nome: e.nome,
          email: e.email,
          origem: "adicionado",
          papel: null,
          historico: e.historySince ? "desde" : "todo",
          desde: e.historySince?.toISOString() ?? null,
        });
      }
      return out;
    }),
  );

const NOME_CANAL: Record<Canal, string> = { interno: "Interno", gerencial: "Gerencial" };

export const adicionarMembro = createServerFn({ method: "POST" })
  .validator(alvo.extend({ personId: z.uuid(), historico: z.enum(["todo", "agora"]) }))
  .handler(async ({ data }) =>
    comoPessoa(async (db, meuId) => {
      if (!(await acesso(db, data.missionId, data.channel)).podeGerenciar) {
        throw new CanalError(`Você não pode alterar quem participa do ${NOME_CANAL[data.channel]}.`);
      }
      const [pessoa] = await db
        .select({ nome: schema.people.displayName, active: schema.people.active })
        .from(schema.people)
        .where(eq(schema.people.id, data.personId));
      if (!pessoa?.active) throw new CanalError("Pessoa não encontrada ou desativada.");
      const [eu] = await db.select({ nome: schema.people.displayName }).from(schema.people).where(eq(schema.people.id, meuId));

      // Hora do banco (início da transação): a mensagem de sistema abaixo usa o
      // mesmo instante, então quem entra "a partir de agora" vê o próprio aviso de entrada.
      const valores = {
        historySince: data.historico === "agora" ? sql`now()` : null,
        addedBy: meuId,
        addedAt: new Date(),
        removedAt: null,
        removedBy: null,
      };
      await db
        .insert(schema.missionMembers)
        .values({ missionId: data.missionId, channel: data.channel, personId: data.personId, ...valores })
        .onConflictDoUpdate({
          target: [schema.missionMembers.missionId, schema.missionMembers.channel, schema.missionMembers.personId],
          set: valores,
        });
      await db.insert(schema.missionMessages).values({
        missionId: data.missionId,
        channel: data.channel,
        authorPersonId: meuId,
        kind: "sistema",
        body: `${eu?.nome ?? "Alguém"} adicionou ${pessoa.nome} (${data.historico === "todo" ? "vê todo o histórico" : "vê a partir de agora"}).`,
      });
      await db.insert(schema.auditLog).values({
        actorPersonId: meuId,
        action: "canal.membro_adicionado",
        entityType: "mission",
        entityId: data.missionId,
        metadata: { channel: data.channel, personId: data.personId, historico: data.historico },
      });
      return { ok: true };
    }),
  );

export const removerMembro = createServerFn({ method: "POST" })
  .validator(alvo.extend({ personId: z.uuid() }))
  .handler(async ({ data }) =>
    comoPessoa(async (db, meuId) => {
      if (!(await acesso(db, data.missionId, data.channel)).podeGerenciar) {
        throw new CanalError(`Você não pode alterar quem participa do ${NOME_CANAL[data.channel]}.`);
      }
      const removidos = await db
        .update(schema.missionMembers)
        .set({ removedAt: new Date(), removedBy: meuId })
        .where(
          and(
            eq(schema.missionMembers.missionId, data.missionId),
            eq(schema.missionMembers.channel, data.channel),
            eq(schema.missionMembers.personId, data.personId),
            isNull(schema.missionMembers.removedAt),
          ),
        )
        .returning({ personId: schema.missionMembers.personId });
      if (!removidos.length) {
        throw new CanalError("Essa pessoa não foi adicionada aqui. Responsáveis vindos do filtroAPP saem quando mudam lá.");
      }
      const [pessoa] = await db.select({ nome: schema.people.displayName }).from(schema.people).where(eq(schema.people.id, data.personId));
      const [eu] = await db.select({ nome: schema.people.displayName }).from(schema.people).where(eq(schema.people.id, meuId));
      await db.insert(schema.missionMessages).values({
        missionId: data.missionId,
        channel: data.channel,
        authorPersonId: meuId,
        kind: "sistema",
        body: `${eu?.nome ?? "Alguém"} removeu ${pessoa?.nome ?? "uma pessoa"}.`,
      });
      await db.insert(schema.auditLog).values({
        actorPersonId: meuId,
        action: "canal.membro_removido",
        entityType: "mission",
        entityId: data.missionId,
        metadata: { channel: data.channel, personId: data.personId },
      });
      return { ok: true };
    }),
  );

/** Pessoas ativas com perfil, para escolher quem adicionar. */
export const listPessoasParaCanal = createServerFn({ method: "GET" }).handler(async () =>
  comoPessoa(async (db) => {
    const rows = await db
      .selectDistinct({ id: schema.people.id, nome: schema.people.displayName })
      .from(schema.people)
      .innerJoin(schema.personProfiles, eq(schema.personProfiles.personId, schema.people.id))
      .where(eq(schema.people.active, true))
      .orderBy(asc(schema.people.displayName));
    return rows;
  }),
);

// ---------------------------------------------------------------- ver como

/**
 * Mostra o canal exatamente como outra pessoa vê: a consulta roda com a
 * identidade dela (mesmo RLS). Só diretoria; fica na auditoria.
 */
export const verComo = createServerFn({ method: "POST" })
  .validator(alvo.extend({ personId: z.uuid() }))
  .handler(async ({ data }) => {
    const meuId = await personIdFromRequest(getRequest());
    if (!meuId) throw new CanalError("Sessão expirada. Entre de novo.");
    const souDiretoria = await withPerson(getPool(), meuId, async (db) => {
      const { rows } = await db.execute<{ ok: boolean }>(sql`SELECT app.has_profile('diretoria') AS ok`);
      if (rows[0]?.ok) {
        await db.insert(schema.auditLog).values({
          actorPersonId: meuId,
          action: "canal.ver_como",
          entityType: "mission",
          entityId: data.missionId,
          metadata: { channel: data.channel, personId: data.personId },
        });
      }
      return Boolean(rows[0]?.ok);
    });
    if (!souDiretoria) throw new CanalError("Só a diretoria pode usar o \"ver como\".");
    return withPerson(getPool(), data.personId, (db) => lerMensagens(db, data.missionId, data.channel, data.personId, false));
  });
