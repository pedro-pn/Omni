import { createPool, createWorkerDb, migrate } from "@omni/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { enviarLembretes } from "./lembretes.ts";

/** Lembretes de tarefas no banco real (omni_test). */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  worker: process.env.TEST_DATABASE_URL_WORKER ?? "postgres://omni_worker:omni_worker_dev@localhost:5433/omni_test",
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

describe.skipIf(!available)("lembretes de tarefas", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let pessoa: string;
  let tarefa: string;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    pessoa = (
      await owner.query<{ id: string }>(
        `INSERT INTO people (email, display_name) VALUES ('lembrete.' || gen_random_uuid() || '@filtrovali.com.br', 'Pessoa Lembrete') RETURNING id`,
      )
    ).rows[0]!.id;
    // Toda terça às 10h, lembrar 1 h antes (09:00 em São Paulo = 12:00 UTC)
    tarefa = (
      await owner.query<{ id: string }>(
        `INSERT INTO tasks (content, owner_person_id, created_by, due_date, due_time, recurrence, reminder_offset_minutes)
         VALUES ('Enviar o relatório semanal', $1, $1, '2026-11-10', '10:00', 'weekly:2', 60) RETURNING id`,
        [pessoa],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), worker?.end()]);
  });

  const avisos = async () =>
    (
      await owner.query<{ title: string; body: string }>(
        "SELECT title, body FROM notifications WHERE task_id = $1 AND kind = 'tarefa_lembrete' ORDER BY created_at",
        [tarefa],
      )
    ).rows;

  it("avisa na hora pedida, uma vez só", async () => {
    const db = createWorkerDb(worker);
    await enviarLembretes(db, new Date("2026-11-10T11:59:00Z"));
    expect(await avisos()).toHaveLength(0);
    await enviarLembretes(db, new Date("2026-11-10T12:00:30Z"));
    await enviarLembretes(db, new Date("2026-11-10T12:01:30Z"));
    expect(await avisos()).toEqual([{ title: "Lembrete: Enviar o relatório semanal", body: "Para 10/11 às 10:00" }]);
  });

  it("tarefa que repete lembra de novo na próxima ocorrência", async () => {
    await owner.query("UPDATE tasks SET due_date = '2026-11-17' WHERE id = $1", [tarefa]);
    await enviarLembretes(createWorkerDb(worker), new Date("2026-11-17T12:00:30Z"));
    expect((await avisos()).map((a) => a.body)).toEqual(["Para 10/11 às 10:00", "Para 17/11 às 10:00"]);
  });

  it("não manda lembrete com mais de um dia de atraso nem de tarefa concluída", async () => {
    await owner.query("UPDATE tasks SET due_date = '2026-11-24' WHERE id = $1", [tarefa]);
    await enviarLembretes(createWorkerDb(worker), new Date("2026-11-26T12:00:00Z"));
    await owner.query("UPDATE tasks SET due_date = '2026-12-01', completed = true WHERE id = $1", [tarefa]);
    await enviarLembretes(createWorkerDb(worker), new Date("2026-12-01T12:00:30Z"));
    expect(await avisos()).toHaveLength(2);
  });
});
