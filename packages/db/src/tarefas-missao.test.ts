import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";
import { taskProjects, tasks } from "./schema.ts";

/** Tarefas da missão (migration 0014): quem vê o Interno participa do projeto da missão. Missão 9301 é deste teste. */

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

describe.skipIf(!available)("tarefas da missão", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let missao: string;
  let lider: string;
  let gestor: string;
  let fora: string;
  const tag = randomUUID().slice(0, 6);

  async function pessoa(nome: string, perfil = "operacao") {
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [
      `${nome}-${tag}@filtrovali.com.br`,
      nome,
    ]);
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, perfil]);
    return rows[0]!.id;
  }
  const projetoDaMissao = (quem: string) =>
    withPerson(app, quem, (db) => db.execute<{ id: string }>(sql`SELECT app.projeto_da_missao(${missao}) AS id`)).then((r) => r.rows[0]!.id);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 3);
    await owner.query("DELETE FROM missions WHERE code = '9301'");
    missao = (
      await owner.query<{ id: string }>(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ('9301', 'tm-9301', 'Porto Sul', true, now()) RETURNING id`,
      )
    ).rows[0]!.id;
    lider = await pessoa("lider");
    gestor = await pessoa("gestor");
    fora = await pessoa("fora");
    await owner.query(
      `INSERT INTO mission_responsibles (mission_id, role, name, email, filtroapp_updated_at) VALUES
       ($1, 'LEADER', 'Líder', $2, now()), ($1, 'PLANNER', 'Gestor', $3, now())`,
      [missao, `lider-${tag}@filtrovali.com.br`, `gestor-${tag}@filtrovali.com.br`],
    );
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("uma missão, um projeto, criado por quem vê o Interno", async () => {
    const id = await projetoDaMissao(gestor);
    expect(await projetoDaMissao(lider)).toBe(id);
    const [p] = await withPerson(app, lider, (db) => db.select().from(taskProjects).where(eq(taskProjects.id, id)));
    expect(p?.name).toBe("Missão 9301 - Porto Sul");
    await expect(projetoDaMissao(fora)).rejects.toThrow();
    expect(await withPerson(app, fora, (db) => db.select().from(taskProjects).where(eq(taskProjects.id, id)))).toHaveLength(0);
  });

  it("quem vê o Interno recebe tarefas; o líder gerencia, o gestor não mexe na do líder", async () => {
    const projeto = await projetoDaMissao(gestor);
    const nova = (quem: string, para: string) =>
      withPerson(app, quem, (db) =>
        db.insert(tasks).values({ content: "Conferir o RDO", projectId: projeto, assigneePersonId: para, dueDate: "2026-11-10", createdBy: quem }).returning(),
      ).then((r) => r[0]!.id);
    const doLider = await nova(gestor, lider);
    const doGestor = await nova(lider, gestor);
    const erro = await nova(gestor, fora).then(
      () => null,
      (e: Error & { cause?: Error }) => `${e.message} | ${e.cause?.message ?? ""}`,
    );
    expect(erro).toMatch(/row-level security/);

    const concluir = (quem: string, id: string) =>
      withPerson(app, quem, (db) => db.update(tasks).set({ completed: true }).where(eq(tasks.id, id)).returning({ id: tasks.id }));
    expect(await concluir(gestor, doLider)).toHaveLength(0);
    expect(await concluir(lider, doGestor)).toHaveLength(1);
  });

  it("membros para a tela: implícitos da missão, com o papel", async () => {
    const projeto = await projetoDaMissao(lider);
    const membros = await withPerson(app, lider, (db) =>
      db.execute<{ person_id: string; role: string }>(sql`SELECT person_id, role FROM app.membros_do_projeto(${projeto})`),
    );
    const papel = Object.fromEntries(membros.rows.map((m) => [m.person_id, m.role]));
    expect(papel[lider]).toBe("manager");
    expect(papel[gestor]).toBe("member");
    expect(papel[fora]).toBeUndefined();
    expect((await withPerson(app, fora, (db) => db.execute(sql`SELECT * FROM app.membros_do_projeto(${projeto})`))).rows).toHaveLength(0);
  });
});
