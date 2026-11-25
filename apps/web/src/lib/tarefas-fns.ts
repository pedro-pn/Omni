import { addDays, nextRecurrenceDate, parseRecurrenceInput, tarefaCombinaComFiltro } from "@omni/core";
import { schema, withPerson, type Db } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";
import { exigirModulo } from "../server/modulos.ts";

/**
 * Tarefas (Fase 3, vindas do Foco). Quem vê e edita é decidido no banco
 * (migration 0009, mesmas regras do Foco); aqui só se monta e se traduz.
 */

export class TarefasError extends ErroParaTela {}

const hojeSaoPaulo = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

async function exigirPessoa(): Promise<string> {
  const personId = await personIdFromRequest(getRequest());
  if (!personId) throw new TarefasError("Sessão expirada. Entre de novo.");
  await exigirModulo(personId, "tarefas");
  return personId;
}

export type PessoaTarefas = { id: string; nome: string; email: string };
export type ProjetoTarefas = {
  id: string;
  nome: string;
  cor: string;
  missionId: string | null;
  abertas: number;
  meuPapel: "owner" | "manager" | "member" | null;
  membros: Array<PessoaTarefas & { papel: "owner" | "manager" | "member" }>;
  secoes: Array<{ id: string; nome: string }>;
};
/** Filtro salvo (linguagem do Foco: `hoje & p1 | @campo`). */
export type FiltroSalvo = { id: string; nome: string; consulta: string; cor: string; favorito: boolean };
export type ContextoTarefas = {
  hoje: string;
  amanha: string;
  projetos: ProjetoTarefas[];
  pessoas: PessoaTarefas[];
  minhas: number;
  atrasadas: number;
  filtros: FiltroSalvo[];
  /** Pastas por etiqueta (@etiqueta) das minhas tarefas abertas, sem diferença de maiúsculas. */
  etiquetas: { nome: string; abertas: number }[];
};

/** Projetos que vejo (com membros e seções), diretório de pessoas e contadores. */
export const contextoTarefas = createServerFn({ method: "GET" }).handler(async (): Promise<ContextoTarefas> => {
  const meuId = await exigirPessoa();
  const hoje = hojeSaoPaulo();
  return withPerson(getPool(), meuId, async (db) => {
    const projetos = await db
      .select()
      .from(schema.taskProjects)
      .where(sql`${schema.taskProjects.archivedAt} IS NULL`)
      .orderBy(asc(schema.taskProjects.name));
    const ids = projetos.map((p) => p.id);
    const [membros, secoes, abertas, pessoas, contadores, filtros, etiquetas] = await Promise.all([
      // Explícitos e, no projeto da missão, quem vê o Interno (migration 0014).
      ids.length
        ? db
            .execute<{ projectId: string; papel: "owner" | "manager" | "member"; id: string; nome: string; email: string }>(
              sql`SELECT p.id AS "projectId", m.role AS papel, pe.id, pe.display_name AS nome, pe.email
                    FROM unnest(${`{${ids.join(",")}}`}::uuid[]) AS p(id)
                    CROSS JOIN LATERAL app.membros_do_projeto(p.id) m
                    JOIN people pe ON pe.id = m.person_id
                   WHERE pe.active
                   ORDER BY pe.display_name`,
            )
            .then((r) => r.rows)
        : [],
      ids.length
        ? db.select().from(schema.taskSections).where(inArray(schema.taskSections.projectId, ids)).orderBy(asc(schema.taskSections.position))
        : [],
      ids.length
        ? db
            .select({ projectId: schema.tasks.projectId, n: sql<number>`count(*)::int` })
            .from(schema.tasks)
            .where(and(inArray(schema.tasks.projectId, ids), eq(schema.tasks.completed, false)))
            .groupBy(schema.tasks.projectId)
        : [],
      db
        .select({ id: schema.people.id, nome: schema.people.displayName, email: schema.people.email })
        .from(schema.people)
        .where(eq(schema.people.active, true))
        .orderBy(asc(schema.people.displayName)),
      db
        .select({
          minhas: sql<number>`count(*)::int`,
          atrasadas: sql<number>`count(*) FILTER (WHERE ${schema.tasks.dueDate} < ${hoje})::int`,
        })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.completed, false), minhasCondicao(meuId))),
      // RLS: só os filtros da própria pessoa.
      db.select().from(schema.taskSavedFilters).orderBy(asc(schema.taskSavedFilters.createdAt)),
      // Cada etiqueta das minhas tarefas abertas vira uma pasta (a grafia mais usada dá o nome).
      db
        .execute<{ nome: string; abertas: number }>(
          sql`SELECT mode() WITHIN GROUP (ORDER BY e.nome) AS nome, count(DISTINCT t.id)::int AS abertas
                FROM tasks t CROSS JOIN LATERAL unnest(t.labels) AS e(nome)
               WHERE NOT t.completed AND (t.owner_person_id = ${meuId} OR t.assignee_person_id = ${meuId}) AND btrim(e.nome) <> ''
               GROUP BY lower(e.nome)
               ORDER BY lower(e.nome)
               LIMIT 200`,
        )
        .then((r) => r.rows),
    ]);
    return {
      hoje,
      amanha: addDays(hoje, 1),
      projetos: projetos.map((p) => ({
        id: p.id,
        nome: p.name,
        cor: p.color,
        missionId: p.missionId,
        abertas: abertas.find((a) => a.projectId === p.id)?.n ?? 0,
        meuPapel: membros.find((m) => m.projectId === p.id && m.id === meuId)?.papel ?? null,
        membros: membros.filter((m) => m.projectId === p.id).map(({ id, nome, email, papel }) => ({ id, nome, email: String(email), papel })),
        secoes: secoes.filter((s) => s.projectId === p.id).map((s) => ({ id: s.id, nome: s.name })),
      })),
      pessoas: pessoas.map((p) => ({ ...p, email: String(p.email) })),
      minhas: contadores[0]?.minhas ?? 0,
      atrasadas: contadores[0]?.atrasadas ?? 0,
      filtros: filtros.map((f) => ({ id: f.id, nome: f.name, consulta: f.query, cor: f.color, favorito: f.favorite })),
      etiquetas,
    };
  });
});

const minhasCondicao = (meuId: string) => or(eq(schema.tasks.ownerPersonId, meuId), eq(schema.tasks.assigneePersonId, meuId))!;

// ---------------------------------------------------------------- lista

export type VistaTarefas =
  | { tipo: "minhas" }
  | { tipo: "delegadas" }
  | { tipo: "projeto"; id: string }
  | { tipo: "filtro"; id: string }
  /** Pasta da etiqueta: minhas tarefas com @nome (sem diferença de maiúsculas). */
  | { tipo: "etiqueta"; nome: string };

export type Tarefa = {
  id: string;
  titulo: string;
  descricao: string;
  data: string;
  hora: string | null;
  recorrencia: string | null;
  prioridade: 1 | 2 | 3 | 4;
  etiquetas: string[];
  concluida: boolean;
  concluidaEm: string | null;
  projeto: { id: string; nome: string; cor: string } | null;
  secaoId: string | null;
  responsavel: { id: string; nome: string } | null;
  criadaPor: string;
  /** Tarefa principal (quando é subtarefa). */
  pai: { id: string; titulo: string } | null;
  /** Subtarefas: quantas e quantas concluídas. */
  subtarefas: { total: number; concluidas: number };
};

const vistaSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("minhas") }),
  z.object({ tipo: z.literal("delegadas") }),
  z.object({ tipo: z.literal("projeto"), id: z.uuid() }),
  z.object({ tipo: z.literal("filtro"), id: z.uuid() }),
  z.object({ tipo: z.literal("etiqueta"), nome: z.string().trim().min(1).max(60) }),
]);

const responsavel = alias(schema.people, "responsavel");
const pai = alias(schema.tasks, "pai");

export const listarTarefas = createServerFn({ method: "GET" })
  .validator(z.object({ vista: vistaSchema, concluidas: z.boolean().default(false) }))
  .handler(async ({ data }): Promise<Tarefa[]> => {
    const meuId = await exigirPessoa();
    const { vista } = data;
    // Filtro salvo: a consulta (linguagem do Foco) roda sobre tudo o que a pessoa vê.
    const filtro =
      vista.tipo === "minhas"
        ? minhasCondicao(meuId)
        : vista.tipo === "delegadas"
          ? and(eq(schema.tasks.createdBy, meuId), isNotNull(schema.tasks.assigneePersonId), ne(schema.tasks.assigneePersonId, meuId))!
          : vista.tipo === "projeto"
            ? eq(schema.tasks.projectId, vista.id)
            : vista.tipo === "etiqueta"
              ? and(minhasCondicao(meuId), sql`EXISTS (SELECT 1 FROM unnest(${schema.tasks.labels}) AS e(nome) WHERE lower(e.nome) = lower(${vista.nome}))`)!
              : undefined;
    const consulta =
      vista.tipo === "filtro"
        ? await withPerson(getPool(), meuId, async (db) => {
            const [f] = await db.select().from(schema.taskSavedFilters).where(eq(schema.taskSavedFilters.id, vista.id));
            if (!f) throw new TarefasError("Filtro não encontrado.");
            const pessoas = await db.select({ nome: schema.people.displayName, email: schema.people.email }).from(schema.people);
            return { texto: f.query, pessoas: pessoas.map((p) => ({ nome: p.nome, email: String(p.email) })) };
          })
        : null;
    const rows = await withPerson(getPool(), meuId, (db) =>
      db
        .select({
          responsavelEmail: responsavel.email,
          t: schema.tasks,
          projeto: schema.taskProjects,
          responsavelNome: responsavel.displayName,
          paiTitulo: pai.content,
          subTotal: sql<number>`(SELECT count(*)::int FROM tasks s WHERE s.parent_task_id = ${schema.tasks.id})`,
          subFeitas: sql<number>`(SELECT count(*)::int FROM tasks s WHERE s.parent_task_id = ${schema.tasks.id} AND s.completed)`,
        })
        .from(schema.tasks)
        .leftJoin(schema.taskProjects, eq(schema.taskProjects.id, schema.tasks.projectId))
        .leftJoin(responsavel, eq(responsavel.id, schema.tasks.assigneePersonId))
        .leftJoin(pai, eq(pai.id, schema.tasks.parentTaskId))
        .where(and(filtro, eq(schema.tasks.completed, data.concluidas)))
        .orderBy(
          ...(data.concluidas
            ? [desc(schema.tasks.completedAt)]
            : [asc(schema.tasks.dueDate), sql`${schema.tasks.dueTime} NULLS LAST`, asc(schema.tasks.priority), asc(schema.tasks.position)]),
        )
        .limit(consulta ? 2000 : data.concluidas ? 30 : 500),
    );
    const hoje = hojeSaoPaulo();
    const escolhidas = consulta
      ? rows
          .filter(({ t, projeto, responsavelEmail }) =>
            tarefaCombinaComFiltro(
              {
                titulo: t.content,
                descricao: t.description,
                data: t.dueDate,
                prioridade: t.priority,
                etiquetas: t.labels,
                concluida: t.completed,
                projetoNome: projeto?.name ?? null,
                responsavelEmail: responsavelEmail ? String(responsavelEmail) : null,
              },
              consulta.texto,
              { hoje, pessoas: consulta.pessoas },
            ),
          )
          .slice(0, data.concluidas ? 50 : 500)
      : rows;
    return escolhidas.map(({ t, projeto, responsavelNome, paiTitulo, subTotal, subFeitas }) => ({
      id: t.id,
      titulo: t.content,
      descricao: t.description,
      data: t.dueDate,
      hora: t.dueTime ? t.dueTime.slice(0, 5) : null,
      recorrencia: t.recurrence,
      prioridade: t.priority as Tarefa["prioridade"],
      etiquetas: t.labels,
      concluida: t.completed,
      concluidaEm: t.completedAt?.toISOString() ?? null,
      projeto: projeto ? { id: projeto.id, nome: projeto.name, cor: projeto.color } : null,
      secaoId: t.sectionId,
      responsavel: t.assigneePersonId ? { id: t.assigneePersonId, nome: responsavelNome ?? "" } : null,
      criadaPor: t.createdBy,
      pai: t.parentTaskId ? { id: t.parentTaskId, titulo: paiTitulo ?? "" } : null,
      subtarefas: { total: subTotal, concluidas: subFeitas },
    }));
  });

// ---------------------------------------------------------------- criar, concluir, reabrir

const novaTarefaSchema = z.object({
  /** Gerado na tela: repetir o envio (lote que falhou no meio) não duplica. */
  id: z.uuid().optional(),
  /** Subtarefa: fica no mesmo lugar (projeto ou caixa) da principal. */
  paiId: z.uuid().optional(),
  titulo: z.string().trim().min(1, "Escreva a tarefa.").max(500),
  descricao: z.string().trim().max(5000).optional(),
  projetoId: z.uuid().nullable(),
  secaoId: z.uuid().nullable(),
  data: z.iso.date(),
  hora: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable(),
  recorrencia: z.string().max(80).nullable(),
  prioridade: z.number().int().min(1).max(4),
  etiquetas: z.array(z.string().trim().min(1).max(40)).max(10),
  responsavelEmail: z.string().max(200).nullable(),
});

async function pessoaPorEmail(db: Db, email: string): Promise<string | null> {
  const [p] = await db
    .select({ id: schema.people.id })
    .from(schema.people)
    .where(and(sql`${schema.people.email} = ${email.toLowerCase()}`, eq(schema.people.active, true)));
  return p?.id ?? null;
}

export const criarTarefa = createServerFn({ method: "POST" })
  .validator(novaTarefaSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const meuId = await exigirPessoa();
    let recorrencia: string | null = null;
    if (data.recorrencia) {
      const r = parseRecurrenceInput(data.recorrencia);
      if (!r.valid || !r.value) throw new TarefasError("Não entendi a repetição. Ex.: toda segunda, todo dia 10.");
      recorrencia = r.value;
    }
    return withPerson(getPool(), meuId, async (db) => {
      if (data.paiId) {
        const [principal] = await db
          .select({ projectId: schema.tasks.projectId, sectionId: schema.tasks.sectionId, parent: schema.tasks.parentTaskId })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, data.paiId));
        if (!principal) throw new TarefasError("Tarefa principal não encontrada.");
        if (principal.parent) throw new TarefasError("Subtarefa não pode ter subtarefas.");
        data.projetoId = principal.projectId;
        data.secaoId = principal.sectionId;
      }
      let responsavelId: string | null = null;
      if (data.responsavelEmail) {
        responsavelId = await pessoaPorEmail(db, data.responsavelEmail);
        if (!responsavelId) throw new TarefasError("Não encontrei essa pessoa no Omni.");
      }
      if (!data.projetoId) {
        if (responsavelId && responsavelId !== meuId) throw new TarefasError("Para delegar, escolha um projeto (#projeto).");
        responsavelId = null;
      } else if (!responsavelId) {
        // Como no Foco: sem +pessoa, a tarefa do projeto fica com quem criou (se for membro).
        const [eu] = await db
          .select({ id: schema.taskProjectMembers.personId })
          .from(schema.taskProjectMembers)
          .where(and(eq(schema.taskProjectMembers.projectId, data.projetoId), eq(schema.taskProjectMembers.personId, meuId)));
        responsavelId = eu ? meuId : null;
      }
      try {
        const [t] = await db
          .insert(schema.tasks)
          .values({
            ...(data.id ? { id: data.id } : {}),
            parentTaskId: data.paiId ?? null,
            content: data.titulo,
            description: data.descricao ?? "",
            projectId: data.projetoId,
            ownerPersonId: data.projetoId ? null : meuId,
            sectionId: data.projetoId ? data.secaoId : null,
            assigneePersonId: responsavelId,
            dueDate: data.data,
            dueTime: data.hora,
            recurrence: recorrencia,
            priority: data.prioridade,
            labels: data.etiquetas,
            createdBy: meuId,
          })
          .onConflictDoNothing({ target: schema.tasks.id })
          .returning({ id: schema.tasks.id });
        return { id: t?.id ?? data.id! };
      } catch {
        throw new TarefasError(
          responsavelId && responsavelId !== meuId
            ? "Essa pessoa não é membro do projeto. Adicione-a ao projeto antes de delegar."
            : "Não foi possível criar a tarefa neste projeto.",
        );
      }
    });
  });

async function exigirEdicao(db: Db, id: string) {
  const r = await db.execute<{ pode: boolean }>(sql`SELECT app.pode_editar_tarefa(${id}) AS pode`);
  if (!r.rows[0]?.pode) throw new TarefasError("Você não pode alterar esta tarefa.");
}

/** Quadro (kanban, como no Foco): arrastar muda só a data ou só a seção (no mesmo projeto). */
export const moverTarefa = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid(), data: z.iso.date().optional(), secaoId: z.uuid().nullable().optional() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      await exigirEdicao(db, data.id);
      const mudar: Partial<typeof schema.tasks.$inferInsert> = {};
      if (data.data) mudar.dueDate = data.data;
      if (data.secaoId !== undefined) mudar.sectionId = data.secaoId;
      if (!Object.keys(mudar).length) return { ok: true };
      try {
        await db.update(schema.tasks).set(mudar).where(eq(schema.tasks.id, data.id));
      } catch {
        throw new TarefasError("Não foi possível mover a tarefa para lá.");
      }
      return { ok: true };
    });
  });

/** Conclui. Tarefa com repetição avança para a próxima data (como no Foco) e continua aberta. */
export const concluirTarefa = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ proximaData: string | null }> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      await exigirEdicao(db, data.id);
      const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, data.id));
      if (!t || t.completed) return { proximaData: null };
      const proxima = t.recurrence ? nextRecurrenceDate(t.recurrence, t.dueDate, hojeSaoPaulo()) : null;
      if (proxima) {
        // Marca para o histórico (0010) registrar "concluiu esta ocorrência", não "mudou a data".
        await db.execute(sql`SELECT set_config('app.acao_tarefa', 'concluir', true)`);
        // Só avança se ninguém avançou antes (duplo clique não pula duas datas).
        await db
          .update(schema.tasks)
          .set({ dueDate: proxima })
          .where(and(eq(schema.tasks.id, t.id), eq(schema.tasks.dueDate, t.dueDate), eq(schema.tasks.completed, false)));
        return { proximaData: proxima };
      }
      await db
        .update(schema.tasks)
        .set({ completed: true, completedAt: new Date(), completedBy: meuId })
        .where(and(eq(schema.tasks.id, t.id), eq(schema.tasks.completed, false)));
      return { proximaData: null };
    });
  });

export const reabrirTarefa = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      await exigirEdicao(db, data.id);
      await db.update(schema.tasks).set({ completed: false, completedAt: null, completedBy: null }).where(eq(schema.tasks.id, data.id));
      return { ok: true as const };
    });
  });

// ---------------------------------------------------------------- projetos

export const criarProjeto = createServerFn({ method: "POST" })
  .validator(z.object({ nome: z.string().trim().min(1, "Dê um nome ao projeto.").max(120) }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      const r = await db.execute<{ id: string }>(sql`SELECT app.criar_projeto_tarefas(${data.nome}, NULL, NULL) AS id`);
      return { id: r.rows[0]!.id };
    });
  });

export const adicionarMembro = createServerFn({ method: "POST" })
  .validator(z.object({ projetoId: z.uuid(), pessoaId: z.uuid() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      try {
        await db
          .insert(schema.taskProjectMembers)
          .values({ projectId: data.projetoId, personId: data.pessoaId, addedBy: meuId })
          .onConflictDoNothing();
      } catch {
        throw new TarefasError("Só quem gerencia o projeto adiciona pessoas.");
      }
      return { ok: true as const };
    });
  });

/**
 * Delegar em lote: cada tarefa numa transação própria, para uma recusa (tarefa
 * da caixa pessoal, responsável fora daquele projeto, sem permissão) não
 * desfazer as outras. Quem decide é o RLS.
 */
export const delegarTarefas = createServerFn({ method: "POST" })
  .validator(z.object({ ids: z.array(z.uuid()).min(1).max(200), pessoaId: z.uuid() }))
  .handler(async ({ data }): Promise<{ delegadas: number; recusadas: number }> => {
    const meuId = await exigirPessoa();
    let delegadas = 0;
    for (const id of data.ids) {
      const ok = await withPerson(getPool(), meuId, async (db) => {
        const r = await db
          .update(schema.tasks)
          .set({ assigneePersonId: data.pessoaId })
          .where(and(eq(schema.tasks.id, id), isNotNull(schema.tasks.projectId)))
          .returning({ id: schema.tasks.id });
        return r.length > 0;
      }).catch(() => false);
      if (ok) delegadas += 1;
    }
    return { delegadas, recusadas: data.ids.length - delegadas };
  });

// ---------------------------------------------------------------- detalhe, edição, exclusão e comentários

export type DetalheTarefa = {
  tarefa: Tarefa & { projetoId: string | null; responsavelId: string | null; lembreteMinutos: number | null };
  podeEditar: boolean;
  podeExcluir: boolean;
  subtarefas: Array<{ id: string; titulo: string; concluida: boolean; data: string; responsavel: string | null }>;
  comentarios: Array<{
    id: string;
    autor: { id: string; nome: string };
    texto: string;
    criadoEm: string;
    editadoEm: string | null;
    mencoes: Array<{ id: string; nome: string }>;
    /** Reações (como no Foco): por emoji, quem reagiu e se fui eu. */
    reacoes: Array<{ emoji: EmojiReacao; pessoas: string[]; minha: boolean }>;
  }>;
  historico: Array<{ id: string; autor: string | null; resumo: string; em: string }>;
};

/** Os mesmos emojis do Foco (o banco confere: migration 0036). */
export const EMOJIS_REACAO = ["👍", "❤️", "😂", "🎉", "😮", "😢"] as const;
export type EmojiReacao = (typeof EMOJIS_REACAO)[number];

const autor = alias(schema.people, "autor");

export type AnexoTarefa = { id: string; nome: string; tipo: string; tamanho: number; autor: string | null; meu: boolean; em: string };

/** Anexos da tarefa (0077): vê quem vê a tarefa (RLS); apaga quem anexou. */
export const anexosDaTarefa = createServerFn({ method: "GET" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<AnexoTarefa[]> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      const linhas = await db
        .select({ a: schema.taskAttachments, autor: autor.displayName })
        .from(schema.taskAttachments)
        .leftJoin(autor, eq(autor.id, schema.taskAttachments.uploadedBy))
        .where(eq(schema.taskAttachments.taskId, data.id))
        .orderBy(asc(schema.taskAttachments.createdAt));
      return linhas.map(({ a, autor: nome }) => ({ id: a.id, nome: a.name, tipo: a.mime, tamanho: a.size, autor: nome, meu: a.uploadedBy === meuId, em: a.createdAt.toISOString() }));
    });
  });

export const obterTarefa = createServerFn({ method: "GET" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<DetalheTarefa> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      const [row] = await db
        .select({ t: schema.tasks, projeto: schema.taskProjects, responsavelNome: responsavel.displayName })
        .from(schema.tasks)
        .leftJoin(schema.taskProjects, eq(schema.taskProjects.id, schema.tasks.projectId))
        .leftJoin(responsavel, eq(responsavel.id, schema.tasks.assigneePersonId))
        .where(eq(schema.tasks.id, data.id));
      if (!row) throw new TarefasError("Tarefa não encontrada.");
      const { t, projeto, responsavelNome } = row;
      const [permissoes] = (
        await db.execute<{ editar: boolean; excluir: boolean }>(sql`
          SELECT app.pode_editar_tarefa(${t.id}) AS editar,
                 (${t.ownerPersonId === meuId} OR ${t.createdBy === meuId}
                  OR (${t.projectId}::uuid IS NOT NULL AND app.pode_gerenciar_projeto(${t.projectId}::uuid))) AS excluir`)
      ).rows;
      const [comentarios, historico, subtarefas, mencoes, [principal], reacoes] = await Promise.all([
        db
          .select({ c: schema.taskComments, nome: autor.displayName })
          .from(schema.taskComments)
          .innerJoin(autor, eq(autor.id, schema.taskComments.authorPersonId))
          .where(eq(schema.taskComments.taskId, t.id))
          .orderBy(asc(schema.taskComments.createdAt)),
        db
          .select({ a: schema.taskActivity, nome: autor.displayName })
          .from(schema.taskActivity)
          .leftJoin(autor, eq(autor.id, schema.taskActivity.actorPersonId))
          .where(eq(schema.taskActivity.taskId, t.id))
          .orderBy(desc(schema.taskActivity.createdAt))
          .limit(100),
        db
          .select({ s: schema.tasks, nome: responsavel.displayName })
          .from(schema.tasks)
          .leftJoin(responsavel, eq(responsavel.id, schema.tasks.assigneePersonId))
          .where(eq(schema.tasks.parentTaskId, t.id))
          .orderBy(asc(schema.tasks.completed), asc(schema.tasks.dueDate), asc(schema.tasks.createdAt)),
        db
          .select({ comentario: schema.taskCommentMentions.commentId, id: autor.id, nome: autor.displayName })
          .from(schema.taskCommentMentions)
          .innerJoin(schema.taskComments, eq(schema.taskComments.id, schema.taskCommentMentions.commentId))
          .innerJoin(autor, eq(autor.id, schema.taskCommentMentions.personId))
          .where(eq(schema.taskComments.taskId, t.id)),
        t.parentTaskId
          ? db.select({ id: schema.tasks.id, titulo: schema.tasks.content }).from(schema.tasks).where(eq(schema.tasks.id, t.parentTaskId))
          : Promise.resolve([] as Array<{ id: string; titulo: string }>),
        db
          .select({ comentario: schema.taskCommentReactions.commentId, emoji: schema.taskCommentReactions.emoji, pessoa: autor.id, nome: autor.displayName })
          .from(schema.taskCommentReactions)
          .innerJoin(schema.taskComments, eq(schema.taskComments.id, schema.taskCommentReactions.commentId))
          .innerJoin(autor, eq(autor.id, schema.taskCommentReactions.personId))
          .where(eq(schema.taskComments.taskId, t.id))
          .orderBy(asc(schema.taskCommentReactions.createdAt)),
      ]);
      return {
        tarefa: {
          id: t.id,
          titulo: t.content,
          descricao: t.description,
          data: t.dueDate,
          hora: t.dueTime ? t.dueTime.slice(0, 5) : null,
          recorrencia: t.recurrence,
          prioridade: t.priority as Tarefa["prioridade"],
          etiquetas: t.labels,
          concluida: t.completed,
          concluidaEm: t.completedAt?.toISOString() ?? null,
          projeto: projeto ? { id: projeto.id, nome: projeto.name, cor: projeto.color } : null,
          secaoId: t.sectionId,
          responsavel: t.assigneePersonId ? { id: t.assigneePersonId, nome: responsavelNome ?? "" } : null,
          criadaPor: t.createdBy,
          projetoId: t.projectId,
          responsavelId: t.assigneePersonId,
          lembreteMinutos: t.reminderOffsetMinutes,
          pai: principal ?? (t.parentTaskId ? { id: t.parentTaskId, titulo: "" } : null),
          subtarefas: { total: subtarefas.length, concluidas: subtarefas.filter((x) => x.s.completed).length },
        },
        subtarefas: subtarefas.map(({ s, nome }) => ({ id: s.id, titulo: s.content, concluida: s.completed, data: s.dueDate, responsavel: nome })),
        podeEditar: Boolean(permissoes?.editar),
        podeExcluir: Boolean(permissoes?.excluir),
        comentarios: comentarios.map(({ c, nome }) => ({
          id: c.id,
          autor: { id: c.authorPersonId, nome },
          texto: c.body,
          criadoEm: c.createdAt.toISOString(),
          editadoEm: c.editedAt?.toISOString() ?? null,
          mencoes: mencoes.filter((m) => m.comentario === c.id).map(({ id, nome }) => ({ id, nome })),
          reacoes: EMOJIS_REACAO.flatMap((emoji) => {
            const deste = reacoes.filter((r) => r.comentario === c.id && r.emoji === emoji);
            return deste.length ? [{ emoji, pessoas: deste.map((r) => r.nome), minha: deste.some((r) => r.pessoa === meuId) }] : [];
          }),
        })),
        historico: historico.map(({ a, nome }) => ({ id: a.id, autor: nome, resumo: a.summary, em: a.createdAt.toISOString() })),
      };
    });
  });

export const editarTarefa = createServerFn({ method: "POST" })
  .validator(
    z.object({
      id: z.uuid(),
      titulo: z.string().trim().min(1, "Escreva a tarefa.").max(500),
      descricao: z.string().trim().max(5000),
      data: z.iso.date(),
      hora: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .nullable(),
      recorrencia: z.string().trim().max(80).nullable(),
      prioridade: z.number().int().min(1).max(4),
      etiquetas: z.array(z.string().trim().min(1).max(40)).max(10),
      projetoId: z.uuid().nullable(),
      secaoId: z.uuid().nullable(),
      responsavelId: z.uuid().nullable(),
      /** Antecedência do lembrete no sino (0 = na hora). */
      lembreteMinutos: z.number().int().min(0).max(10_080).nullable(),
    }),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const meuId = await exigirPessoa();
    let recorrencia: string | null = null;
    if (data.recorrencia) {
      const r = parseRecurrenceInput(data.recorrencia);
      if (!r.valid) throw new TarefasError(r.message || "Não entendi a repetição. Ex.: toda segunda, todo dia 10.");
      recorrencia = r.value;
    }
    if (!data.projetoId && data.responsavelId && data.responsavelId !== meuId) {
      throw new TarefasError("Para delegar, escolha um projeto.");
    }
    return withPerson(getPool(), meuId, async (db) => {
      await exigirEdicao(db, data.id);
      try {
        const r = await db
          .update(schema.tasks)
          .set({
            content: data.titulo,
            description: data.descricao,
            dueDate: data.data,
            dueTime: data.hora,
            recurrence: recorrencia,
            priority: data.prioridade,
            labels: data.etiquetas,
            projectId: data.projetoId,
            // Sem projeto, a tarefa vai para a caixa pessoal de quem editou (como no Foco).
            ownerPersonId: data.projetoId ? null : meuId,
            sectionId: data.projetoId ? data.secaoId : null,
            assigneePersonId: data.projetoId ? data.responsavelId : null,
            reminderOffsetMinutes: data.lembreteMinutos,
          })
          .where(eq(schema.tasks.id, data.id))
          .returning({ id: schema.tasks.id });
        if (!r.length) throw new Error("sem linha");
      } catch {
        throw new TarefasError("Não foi possível salvar. O responsável precisa ser membro do projeto escolhido.");
      }
      return { ok: true as const };
    });
  });

export const excluirTarefa = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      const r = await db.delete(schema.tasks).where(eq(schema.tasks.id, data.id)).returning({ id: schema.tasks.id });
      if (!r.length) throw new TarefasError("Só quem criou a tarefa ou gerencia o projeto pode excluir.");
      return { ok: true as const };
    });
  });

export const comentarTarefa = createServerFn({ method: "POST" })
  .validator(
    z.object({
      tarefaId: z.uuid(),
      texto: z.string().trim().min(1, "Escreva o comentário.").max(5000),
      /** Pessoas marcadas com @ (só entram as que enxergam a tarefa). */
      mencoes: z.array(z.uuid()).max(20).default([]),
    }),
  )
  .handler(async ({ data }): Promise<{ id: string; foraDaTarefa: number }> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      let comentarioId: string;
      try {
        const [c] = await db
          .insert(schema.taskComments)
          .values({ taskId: data.tarefaId, authorPersonId: meuId, body: data.texto })
          .returning({ id: schema.taskComments.id });
        comentarioId = c!.id;
      } catch {
        throw new TarefasError("Você não tem acesso a esta tarefa.");
      }
      const marcados = [...new Set(data.mencoes)].filter((id) => id !== meuId);
      let foraDaTarefa = 0;
      for (const pessoa of marcados) {
        const r = await db.execute<{ ve: boolean }>(sql`SELECT app.pessoa_ve_tarefa(${data.tarefaId}, ${pessoa}) AS ve`);
        if (!r.rows[0]?.ve) {
          foraDaTarefa += 1;
          continue;
        }
        await db.insert(schema.taskCommentMentions).values({ commentId: comentarioId, personId: pessoa });
      }
      return { id: comentarioId, foraDaTarefa };
    });
  });

// ---------------------------------------------------------------- filtros salvos

export const salvarFiltro = createServerFn({ method: "POST" })
  .validator(
    z.object({
      nome: z.string().trim().min(1, "Dê um nome ao filtro.").max(80),
      consulta: z.string().trim().min(1, "Escolha pelo menos uma condição.").max(500),
      favorito: z.boolean().default(false),
    }),
  )
  .handler(async ({ data }): Promise<{ id: string }> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      const [f] = await db
        .insert(schema.taskSavedFilters)
        .values({ personId: meuId, name: data.nome, query: data.consulta, favorite: data.favorito })
        .returning({ id: schema.taskSavedFilters.id });
      return { id: f!.id };
    });
  });

export const excluirFiltro = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      await db.delete(schema.taskSavedFilters).where(eq(schema.taskSavedFilters.id, data.id));
      return { ok: true };
    });
  });

/** Reagir a um comentário (de novo com o mesmo emoji: tira). */
export const reagirComentario = createServerFn({ method: "POST" })
  .validator(z.object({ comentarioId: z.uuid(), emoji: z.enum(EMOJIS_REACAO) }))
  .handler(async ({ data }) => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      const r = schema.taskCommentReactions;
      const tiradas = await db
        .delete(r)
        .where(and(eq(r.commentId, data.comentarioId), eq(r.personId, meuId), eq(r.emoji, data.emoji)))
        .returning({ emoji: r.emoji });
      if (tiradas.length) return { reagiu: false };
      try {
        await db.insert(r).values({ commentId: data.comentarioId, personId: meuId, emoji: data.emoji });
      } catch {
        throw new TarefasError("Você não tem acesso a esta tarefa.");
      }
      return { reagiu: true };
    });
  });

// ---------------------------------------------------------------- seções

export const criarSecao = createServerFn({ method: "POST" })
  .validator(z.object({ projetoId: z.uuid(), nome: z.string().trim().min(1, "Dê um nome à seção.").max(120) }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      const [{ proxima }] = (await db
        .select({ proxima: sql<number>`coalesce(max(${schema.taskSections.position}), -1)::int + 1` })
        .from(schema.taskSections)
        .where(eq(schema.taskSections.projectId, data.projetoId))) as [{ proxima: number }];
      try {
        const [s] = await db
          .insert(schema.taskSections)
          .values({ projectId: data.projetoId, name: data.nome, position: proxima })
          .returning({ id: schema.taskSections.id });
        return { id: s!.id };
      } catch {
        throw new TarefasError("Só membros do projeto criam seções.");
      }
    });
  });

export const alterarSecao = createServerFn({ method: "POST" })
  .validator(
    z.object({
      id: z.uuid(),
      nome: z.string().trim().min(1).max(120).optional(),
      /** -1 sobe, 1 desce. */
      mover: z.union([z.literal(-1), z.literal(1)]).optional(),
      excluir: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      const [s] = await db.select().from(schema.taskSections).where(eq(schema.taskSections.id, data.id));
      if (!s) throw new TarefasError("Seção não encontrada.");
      if (data.excluir) {
        // As tarefas ficam sem seção (FK ON DELETE SET NULL).
        await db.delete(schema.taskSections).where(eq(schema.taskSections.id, s.id));
        return { ok: true as const };
      }
      if (data.nome) await db.update(schema.taskSections).set({ name: data.nome }).where(eq(schema.taskSections.id, s.id));
      if (data.mover) {
        const irmas = await db
          .select()
          .from(schema.taskSections)
          .where(eq(schema.taskSections.projectId, s.projectId))
          .orderBy(asc(schema.taskSections.position), asc(schema.taskSections.createdAt));
        const i = irmas.findIndex((x) => x.id === s.id);
        const j = i + data.mover;
        if (j >= 0 && j < irmas.length) {
          [irmas[i], irmas[j]] = [irmas[j]!, irmas[i]!];
          // Renumera tudo (posições repetidas de dados antigos não atrapalham).
          for (const [pos, x] of irmas.entries()) {
            await db.update(schema.taskSections).set({ position: pos }).where(eq(schema.taskSections.id, x.id));
          }
        }
      }
      return { ok: true as const };
    });
  });

export const editarComentario = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid(), texto: z.string().trim().min(1).max(5000) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      const r = await db
        .update(schema.taskComments)
        .set({ body: data.texto, editedAt: new Date() })
        .where(eq(schema.taskComments.id, data.id))
        .returning({ id: schema.taskComments.id });
      if (!r.length) throw new TarefasError("Só quem escreveu edita o comentário.");
      return { ok: true as const };
    });
  });

export const excluirComentario = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const meuId = await exigirPessoa();
    return withPerson(getPool(), meuId, async (db) => {
      const r = await db.delete(schema.taskComments).where(eq(schema.taskComments.id, data.id)).returning({ id: schema.taskComments.id });
      if (!r.length) throw new TarefasError("Só quem escreveu apaga o comentário.");
      return { ok: true as const };
    });
  });

/** O projeto de tarefas da missão (criado na primeira vez; só para quem vê o Interno). */
export const projetoDaMissao = createServerFn({ method: "POST" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const meuId = await exigirPessoa();
    try {
      const r = await withPerson(getPool(), meuId, (db) =>
        db.execute<{ id: string }>(sql`SELECT app.projeto_da_missao(${data.missionId}) AS id`),
      );
      return { id: r.rows[0]!.id };
    } catch {
      throw new TarefasError("Você não vê o Interno desta missão.");
    }
  });

