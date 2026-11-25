import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";
import { calendarFeeds, notifications, taskActivity, taskCommentMentions, taskCommentReactions, taskComments, taskProjectMembers, taskProjects, taskSavedFilters, taskSections, tasks, taskAttachments } from "./schema.ts";

/** Permissões das Tarefas (migrations 0009–0015), as mesmas regras do Foco, avisos, menções e subtarefas. */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  app: process.env.TEST_DATABASE_URL_APP ?? "postgres://omni_app:omni_app_dev@localhost:5433/omni_test",
};

async function disponivel(): Promise<boolean> {
  const client = new pg.Client({ connectionString: urls.owner, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    if (process.env.CI) throw new Error("Banco de teste indisponível no CI");
    return false;
  }
}
const available = await disponivel();

async function falha(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as Error & { cause?: Error },
  );
  expect(error, "deveria ter sido recusado").not.toBeNull();
  expect(`${error?.message} | ${error?.cause?.message ?? ""}`).toMatch(pattern);
}

describe.skipIf(!available)("permissões das tarefas", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let dono: string;
  let membro: string;
  let outro: string;
  let fora: string;
  let diretora: string;
  let projeto: string;
  let secaoDeOutro: string;
  const tag = randomUUID().slice(0, 6);

  async function pessoa(nome: string, perfil: string) {
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [
      `${nome}-${tag}@filtrovali.com.br`,
      nome,
    ]);
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, perfil]);
    return rows[0]!.id;
  }

  const criarProjeto = (quem: string, nome: string) =>
    withPerson(app, quem, async (db) => {
      const r = await db.execute<{ id: string }>(sql`SELECT app.criar_projeto_tarefas(${nome}, NULL, NULL) AS id`);
      return r.rows[0]!.id;
    });

  const novaTarefa = (quem: string, valores: Partial<typeof tasks.$inferInsert>) =>
    withPerson(app, quem, (db) =>
      db
        .insert(tasks)
        .values({ content: "Tarefa", dueDate: "2026-11-10", createdBy: quem, ...valores })
        .returning({ id: tasks.id }),
    ).then((r) => r[0]!.id);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 3);
    dono = await pessoa("dono", "operacao");
    membro = await pessoa("membro", "operacao");
    outro = await pessoa("outro", "operacao");
    fora = await pessoa("fora", "operacao");
    diretora = await pessoa("diretora", "diretoria");
    projeto = await criarProjeto(dono, `Projeto ${tag}`);
    await withPerson(app, dono, (db) =>
      db.insert(taskProjectMembers).values([
        { projectId: projeto, personId: membro, addedBy: dono },
        { projectId: projeto, personId: outro, addedBy: dono },
      ]),
    );
    const outroProjeto = await criarProjeto(fora, `Outro ${tag}`);
    secaoDeOutro = (
      await withPerson(app, fora, (db) => db.insert(taskSections).values({ projectId: outroProjeto, name: "Seção" }).returning())
    )[0]!.id;
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("quem cria o projeto vira owner; quem não é membro não vê; diretoria vê", async () => {
    const [m] = await withPerson(app, dono, (db) =>
      db.select().from(taskProjectMembers).where(and(eq(taskProjectMembers.projectId, projeto), eq(taskProjectMembers.personId, dono))),
    );
    expect(m?.role).toBe("owner");
    expect(await withPerson(app, fora, (db) => db.select().from(taskProjects).where(eq(taskProjects.id, projeto)))).toHaveLength(0);
    expect(await withPerson(app, diretora, (db) => db.select().from(taskProjects).where(eq(taskProjects.id, projeto)))).toHaveLength(1);
  });

  it("projeto só nasce pela função (com o dono junto)", async () => {
    await falha(
      withPerson(app, dono, (db) => db.insert(taskProjects).values({ name: "Direto", createdBy: dono })),
      /permission denied/,
    );
  });

  it("caixa pessoal: só o dono vê e não dá para delegar nem pôr na caixa de outro", async () => {
    const minha = await novaTarefa(dono, { ownerPersonId: dono });
    expect(await withPerson(app, diretora, (db) => db.select().from(tasks).where(eq(tasks.id, minha)))).toHaveLength(0);
    await falha(novaTarefa(membro, { ownerPersonId: dono }), /row-level security/);
    await falha(novaTarefa(dono, { ownerPersonId: dono, assigneePersonId: membro }), /tasks_caixa_sem_delegar/);
  });

  it("responsável precisa ser membro; seção precisa ser do projeto", async () => {
    await novaTarefa(dono, { projectId: projeto, assigneePersonId: membro });
    await falha(novaTarefa(dono, { projectId: projeto, assigneePersonId: fora }), /row-level security/);
    await falha(novaTarefa(dono, { projectId: projeto, sectionId: secaoDeOutro }), /row-level security/);
    await falha(novaTarefa(fora, { projectId: projeto }), /row-level security/);
  });

  it("membro edita a sua e as sem responsável; a de outro, só quem gerencia", async () => {
    const doOutro = await novaTarefa(dono, { projectId: projeto, assigneePersonId: outro });
    const semResponsavel = await novaTarefa(dono, { projectId: projeto });
    const concluir = (quem: string, id: string) =>
      withPerson(app, quem, (db) => db.update(tasks).set({ completed: true }).where(eq(tasks.id, id)).returning({ id: tasks.id }));

    expect(await concluir(membro, doOutro)).toHaveLength(0);
    expect(await concluir(membro, semResponsavel)).toHaveLength(1);
    expect(await concluir(outro, doOutro)).toHaveLength(1);
    const gerenciada = await novaTarefa(dono, { projectId: projeto, assigneePersonId: membro });
    expect(await concluir(dono, gerenciada)).toHaveLength(1);
  });

  it("delegar: só para membro e nunca a tarefa da caixa pessoal", async () => {
    const t = await novaTarefa(dono, { projectId: projeto, assigneePersonId: dono });
    const delegar = (id: string, para: string) =>
      withPerson(app, dono, (db) => db.update(tasks).set({ assigneePersonId: para }).where(eq(tasks.id, id)).returning({ id: tasks.id }));
    expect(await delegar(t, membro)).toHaveLength(1);
    await falha(delegar(t, fora), /row-level security/);
    const caixa = await novaTarefa(dono, { ownerPersonId: dono });
    await falha(delegar(caixa, membro), /tasks_caixa_sem_delegar/);
  });

  it("comentários: quem vê a tarefa comenta; cada um mexe só no seu", async () => {
    const t = await novaTarefa(dono, { projectId: projeto });
    const [c] = await withPerson(app, membro, (db) => db.insert(taskComments).values({ taskId: t, authorPersonId: membro, body: "Feito o contato" }).returning());
    await falha(
      withPerson(app, fora, (db) => db.insert(taskComments).values({ taskId: t, authorPersonId: fora, body: "x" })),
      /row-level security/,
    );
    await falha(
      withPerson(app, dono, (db) => db.insert(taskComments).values({ taskId: t, authorPersonId: membro, body: "em nome de outro" })),
      /row-level security/,
    );
    const editar = (quem: string) =>
      withPerson(app, quem, (db) => db.update(taskComments).set({ body: "mudou", editedAt: new Date() }).where(eq(taskComments.id, c!.id)).returning());
    expect(await editar(dono)).toHaveLength(0);
    expect(await editar(membro)).toHaveLength(1);
    expect(await withPerson(app, fora, (db) => db.select().from(taskComments).where(eq(taskComments.taskId, t)))).toHaveLength(0);
  });

  it("anexos (0077): quem vê a tarefa anexa e vê; só quem anexou apaga; quem não vê, nem vê nem anexa", async () => {
    const t = await novaTarefa(dono, { projectId: projeto });
    const anexo = (quem: string) => ({ taskId: t, name: "foto.jpg", mime: "image/jpeg", size: 10, spDriveId: "d", spItemId: `i-${randomUUID()}`, uploadedBy: quem });
    const [a] = await withPerson(app, membro, (db) => db.insert(taskAttachments).values(anexo(membro)).returning());
    await falha(withPerson(app, fora, (db) => db.insert(taskAttachments).values(anexo(fora))), /row-level security/);
    await falha(withPerson(app, dono, (db) => db.insert(taskAttachments).values(anexo(membro))), /row-level security/);
    expect(await withPerson(app, dono, (db) => db.select().from(taskAttachments).where(eq(taskAttachments.taskId, t)))).toHaveLength(1);
    expect(await withPerson(app, fora, (db) => db.select().from(taskAttachments).where(eq(taskAttachments.taskId, t)))).toHaveLength(0);
    expect(await withPerson(app, dono, (db) => db.delete(taskAttachments).where(eq(taskAttachments.id, a!.id)).returning())).toHaveLength(0);
    expect(await withPerson(app, membro, (db) => db.delete(taskAttachments).where(eq(taskAttachments.id, a!.id)).returning())).toHaveLength(1);
  });

  it("reações: quem vê a tarefa reage; cada um tira só a sua; o autor recebe um aviso só", async () => {
    const t = await novaTarefa(dono, { projectId: projeto });
    const [c] = await withPerson(app, dono, (db) => db.insert(taskComments).values({ taskId: t, authorPersonId: dono, body: "Comentário com reação" }).returning());
    const reagir = (quem: string, emoji: "👍" | "🎉" = "👍") =>
      withPerson(app, quem, (db) => db.insert(taskCommentReactions).values({ commentId: c!.id, personId: quem, emoji }));
    await reagir(membro);
    await falha(reagir(fora), /row-level security/);
    await falha(
      withPerson(app, dono, (db) => db.insert(taskCommentReactions).values({ commentId: c!.id, personId: membro, emoji: "🎉" })),
      /row-level security/,
    );
    const tirar = (quem: string, de: string) =>
      withPerson(app, quem, (db) => db.delete(taskCommentReactions).where(and(eq(taskCommentReactions.commentId, c!.id), eq(taskCommentReactions.personId, de))).returning());
    expect(await tirar(dono, membro)).toHaveLength(0);
    expect(await tirar(membro, membro)).toHaveLength(1);
    await reagir(membro); // tirar e pôr de novo não repete o aviso
    const avisos = await owner.query("SELECT 1 FROM notifications WHERE kind = 'tarefa_reacao' AND person_id = $1 AND task_id = $2", [dono, t]);
    expect(avisos.rows).toHaveLength(1);
    expect(await withPerson(app, fora, (db) => db.select().from(taskCommentReactions).where(eq(taskCommentReactions.commentId, c!.id)))).toHaveLength(0);
  });

  it("filtros salvos: cada um vê, muda e apaga só os seus", async () => {
    const [f] = await withPerson(app, dono, (db) => db.insert(taskSavedFilters).values({ personId: dono, name: "Hoje urgente", query: "hoje & p1" }).returning());
    await falha(
      withPerson(app, membro, (db) => db.insert(taskSavedFilters).values({ personId: dono, name: "x", query: "p1" })),
      /row-level security/,
    );
    expect(await withPerson(app, membro, (db) => db.select().from(taskSavedFilters).where(eq(taskSavedFilters.id, f!.id)))).toHaveLength(0);
    expect(await withPerson(app, membro, (db) => db.delete(taskSavedFilters).where(eq(taskSavedFilters.id, f!.id)).returning())).toHaveLength(0);
    expect(await withPerson(app, dono, (db) => db.update(taskSavedFilters).set({ favorite: true }).where(eq(taskSavedFilters.id, f!.id)).returning())).toHaveLength(1);
    await falha(
      withPerson(app, dono, (db) => db.update(taskSavedFilters).set({ personId: membro }).where(eq(taskSavedFilters.id, f!.id))),
      /permission denied/,
    );
  });

  it("agenda .ics: cada um só o próprio link; sem sessão, só pela função e se a pessoa estiver ativa", async () => {
    const [f] = await withPerson(app, dono, (db) =>
      db.insert(calendarFeeds).values({ personId: dono, signedSubject: dono, signedCreated: new Date().toISOString() }).returning(),
    );
    await falha(
      withPerson(app, membro, (db) => db.insert(calendarFeeds).values({ personId: membro, signedSubject: dono, signedCreated: "x" })),
      /row-level security/,
    );
    expect(await withPerson(app, membro, (db) => db.select().from(calendarFeeds).where(eq(calendarFeeds.id, f!.id)))).toHaveLength(0);
    const porLink = () => app.query("SELECT * FROM app.agenda_por_link($1)", [f!.id]).then((r) => r.rows);
    expect(await porLink()).toEqual([{ person_id: dono, signed_subject: dono, signed_created: f!.signedCreated }]);
    await owner.query("UPDATE people SET active = false WHERE id = $1", [dono]);
    expect(await porLink()).toEqual([]);
    await owner.query("UPDATE people SET active = true WHERE id = $1", [dono]);
    await withPerson(app, dono, (db) => db.delete(calendarFeeds).where(eq(calendarFeeds.id, f!.id)));
  });

  it("histórico: o banco registra as mudanças e a tela não escreve nele", async () => {
    const t = await novaTarefa(dono, { projectId: projeto, assigneePersonId: dono, recurrence: "weekly:1" });
    // Concluir a ocorrência (marca da conclusão) × adiantar a data à mão
    await withPerson(app, dono, async (db) => {
      await db.execute(sql`SELECT set_config('app.acao_tarefa', 'concluir', true)`);
      await db.update(tasks).set({ dueDate: "2026-11-16" }).where(eq(tasks.id, t));
    });
    await withPerson(app, dono, (db) => db.update(tasks).set({ dueDate: "2026-11-23" }).where(eq(tasks.id, t)));
    await withPerson(app, dono, (db) => db.update(tasks).set({ assigneePersonId: membro, priority: 1 }).where(eq(tasks.id, t)));
    await withPerson(app, membro, (db) => db.update(tasks).set({ completed: true }).where(eq(tasks.id, t)));
    const h = await withPerson(app, dono, (db) => db.select().from(taskActivity).where(eq(taskActivity.taskId, t)).orderBy(taskActivity.createdAt));
    expect(h.map((x) => x.action)).toEqual(["criada", "repetiu", "data", "responsavel", "prioridade", "concluida"]);
    expect(h[1]?.summary).toBe("Concluiu esta ocorrência; a próxima é 16/11/2026");
    expect(h.find((x) => x.action === "responsavel")?.summary).toBe("Passou para membro");
    expect(h.at(-1)?.actorPersonId).toBe(membro);
    await falha(
      withPerson(app, dono, (db) => db.insert(taskActivity).values({ taskId: t, action: "x", summary: "forjado" })),
      /permission denied/,
    );
  });

  it("avisos: passar, concluir e comentar avisam as pessoas certas; cada um vê só os seus", async () => {
    const meus = (quem: string, t: string) =>
      withPerson(app, quem, (db) => db.select().from(notifications).where(eq(notifications.taskId, t)).orderBy(notifications.createdAt));
    const t = await novaTarefa(dono, { projectId: projeto, assigneePersonId: membro, content: "Medir a obra" });
    expect((await meus(membro, t)).map((n) => [n.kind, n.title])).toEqual([["tarefa_atribuida", "dono passou uma tarefa para você"]]);
    expect(await meus(dono, t)).toHaveLength(0); // não avisa quem fez

    await withPerson(app, membro, (db) => db.insert(taskComments).values({ taskId: t, authorPersonId: membro, body: "Começo amanhã" }));
    await withPerson(app, membro, (db) => db.update(tasks).set({ completed: true }).where(eq(tasks.id, t)));
    expect((await meus(dono, t)).map((n) => n.kind)).toEqual(["tarefa_comentario", "tarefa_concluida"]);

    // Ninguém cria aviso pela tela, nem lê ou marca o de outra pessoa
    await falha(
      withPerson(app, dono, (db) => db.insert(notifications).values({ personId: membro, kind: "tarefa_lembrete", title: "x" })),
      /permission denied/,
    );
    const lidos = await withPerson(app, dono, (db) =>
      db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.personId, membro)).returning(),
    );
    expect(lidos).toHaveLength(0);
  });

  it("menção: só de quem escreveu, só para quem enxerga a tarefa, e substitui o aviso de comentário", async () => {
    const t = await novaTarefa(dono, { projectId: projeto, assigneePersonId: membro, content: "Revisar o orçamento" });
    const [c] = await withPerson(app, dono, async (db) => {
      const [comentario] = await db.insert(taskComments).values({ taskId: t, authorPersonId: dono, body: "@membro olha isso" }).returning();
      await db.insert(taskCommentMentions).values({ commentId: comentario!.id, personId: membro });
      return [comentario];
    });
    const avisos = await withPerson(app, membro, (db) => db.select().from(notifications).where(eq(notifications.taskId, t)));
    expect(avisos.map((n) => n.kind).sort()).toEqual(["tarefa_atribuida", "tarefa_mencao"]);
    expect(avisos.find((n) => n.kind === "tarefa_mencao")?.title).toBe("dono mencionou você em “Revisar o orçamento”");

    await falha(withPerson(app, dono, (db) => db.insert(taskCommentMentions).values({ commentId: c!.id, personId: fora })), /row-level security/);
    await falha(withPerson(app, membro, (db) => db.insert(taskCommentMentions).values({ commentId: c!.id, personId: dono })), /row-level security/);
  });

  it("subtarefa: um nível, no mesmo lugar da principal; principal com subtarefas não muda de lugar", async () => {
    const pai = await novaTarefa(dono, { projectId: projeto });
    const filha = await novaTarefa(dono, { projectId: projeto, parentTaskId: pai });
    await falha(novaTarefa(dono, { projectId: projeto, parentTaskId: filha }), /não pode ter subtarefas/);
    await falha(novaTarefa(dono, { ownerPersonId: dono, parentTaskId: pai }), /mesmo lugar/);
    await falha(
      withPerson(app, dono, (db) => db.update(tasks).set({ projectId: null, ownerPersonId: dono }).where(eq(tasks.id, pai))),
      /mova as subtarefas/,
    );
  });

  it("membro não tira outros do projeto, mas pode sair", async () => {
    const tirar = (quem: string, alvo: string) =>
      withPerson(app, quem, (db) =>
        db
          .delete(taskProjectMembers)
          .where(and(eq(taskProjectMembers.projectId, projeto), eq(taskProjectMembers.personId, alvo)))
          .returning(),
      );
    expect(await tirar(membro, outro)).toHaveLength(0);
    expect(await tirar(outro, outro)).toHaveLength(1);
  });
});
