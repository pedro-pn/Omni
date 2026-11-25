import { createPool, createWorkerDb, migrate } from "@omni/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { enviarAvisosPorEmail, enviarResumoSemanal, type EnviarEmail } from "./emails.ts";

/** Avisos por e-mail e resumo semanal, no banco real (omni_test). Pessoas @email-teste.invalid são deste arquivo. */

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
const app = "https://omni.teste.invalid";

describe.skipIf(!available)("avisos das tarefas por e-mail", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let ana: string;
  let bia: string;
  let tarefa: string;
  const db = () => createWorkerDb(worker);
  const aviso = async (pessoa: string, kind: string, minutosAtras: number, lido = false) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO notifications (person_id, kind, title, body, task_id, created_at, read_at)
         VALUES ($1, $2, $3, 'corpo', $4, now() - make_interval(mins => $5), CASE WHEN $6 THEN now() END) RETURNING id`,
        [pessoa, kind, `Aviso ${kind}`, tarefa, minutosAtras, lido],
      )
    ).rows[0]!.id;
  const status = async (id: string) => (await owner.query("SELECT email_status FROM notifications WHERE id = $1", [id])).rows[0]!.email_status;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
  });
  beforeEach(async () => {
    await owner.query("DELETE FROM notification_emails WHERE to_address LIKE '%@email-teste.invalid'");
    await owner.query("DELETE FROM notifications WHERE person_id IN (SELECT id FROM people WHERE email LIKE '%@email-teste.invalid')");
    await owner.query("DELETE FROM task_activity WHERE task_id IN (SELECT id FROM tasks WHERE content LIKE 'EMAILTESTE%')");
    await owner.query("DELETE FROM tasks WHERE content LIKE 'EMAILTESTE%'");
    await owner.query("DELETE FROM email_preferences WHERE person_id IN (SELECT id FROM people WHERE email LIKE '%@email-teste.invalid')");
    await owner.query("DELETE FROM people WHERE email LIKE '%@email-teste.invalid'");
    ana = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ('ana@email-teste.invalid', 'Ana Souza') RETURNING id")).rows[0]!.id;
    bia = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ('bia@email-teste.invalid', 'Bia Lima') RETURNING id")).rows[0]!.id;
    tarefa = (await owner.query<{ id: string }>("INSERT INTO tasks (content, due_date, owner_person_id, created_by) VALUES ('EMAILTESTE base', current_date, $1, $1) RETURNING id", [ana])).rows[0]!.id;
    await owner.query("DELETE FROM notifications WHERE task_id = $1", [tarefa]);
    // Outros avisos do banco compartilhado não entram nesta rodada.
    await owner.query("UPDATE notifications SET email_status = 'ignorado' WHERE email_status IS NULL AND person_id NOT IN ($1, $2)", [ana, bia]);
  });
  afterAll(async () => {
    await Promise.all([owner?.end(), worker?.end()]);
  });

  it("um e-mail por pessoa com os avisos dela; lido, recente demais, sem e-mail ou desligado ficam fora", async () => {
    const a1 = await aviso(ana, "tarefa_atribuida", 5);
    const a2 = await aviso(ana, "tarefa_mencao", 4);
    const lido = await aviso(ana, "tarefa_comentario", 4, true);
    const recente = await aviso(ana, "tarefa_comentario", 0);
    const ia = await aviso(ana, "ia_pergunta", 5);
    const concluida = await aviso(bia, "tarefa_concluida", 5); // padrão: concluídas não vão por e-mail
    await owner.query("INSERT INTO email_preferences (person_id, lembretes) VALUES ($1, false)", [bia]);
    const lembrete = await aviso(bia, "tarefa_lembrete", 5);
    const r = await enviarAvisosPorEmail(db(), { modo: "ensaio", app, enviar: null });
    expect(r).toMatchObject({ emails: 1, avisos: 2, falhas: 0 });
    expect([await status(a1), await status(a2)]).toEqual(["ensaio", "ensaio"]);
    for (const id of [lido, ia, concluida, lembrete]) expect(await status(id)).toBe("ignorado");
    expect(await status(recente)).toBeNull();
    const [e] = (await owner.query("SELECT subject, mode, status, cardinality(notification_ids) AS n FROM notification_emails WHERE person_id = $1", [ana])).rows;
    expect(e).toEqual({ subject: "[Omni] 2 novos avisos", mode: "ensaio", status: "ensaio", n: 2 });
    expect((await enviarAvisosPorEmail(db(), { modo: "ensaio", app, enviar: null })).emails).toBe(0); // não manda de novo
  });

  it("real: manda pelo remetente; falha deixa na fila para a próxima rodada", async () => {
    const id = await aviso(bia, "tarefa_atribuida", 5);
    const enviados: string[] = [];
    let falhar = true;
    const enviar: EnviarEmail = async (para, e) => {
      if (falhar) throw new Error("Graph respondeu 503");
      enviados.push(`${para}|${e.assunto}|${e.html.includes(`${app}/?tarefa=${tarefa}`)}`);
    };
    expect((await enviarAvisosPorEmail(db(), { modo: "real", app, enviar })).falhas).toBe(1);
    expect(await status(id)).toBeNull();
    falhar = false;
    expect((await enviarAvisosPorEmail(db(), { modo: "real", app, enviar })).emails).toBe(1);
    expect(enviados).toEqual(["bia@email-teste.invalid|[Omni] 1 novo aviso|true"]);
    expect(await status(id)).toBe("enviado");
  });

  it("resumo semanal: atrasadas e da semana de quem tem tarefa; uma vez por semana; preferência desligada não recebe", async () => {
    const hoje = (await owner.query<{ d: string }>("SELECT current_date::text AS d")).rows[0]!.d;
    await owner.query("INSERT INTO tasks (content, due_date, priority, owner_person_id, created_by) VALUES ('EMAILTESTE atrasada', current_date - 3, 1, $1, $1)", [ana]);
    await owner.query("INSERT INTO tasks (content, due_date, priority, owner_person_id, created_by) VALUES ('EMAILTESTE atrasada bia', current_date - 3, 1, $1, $1)", [bia]);
    await owner.query("INSERT INTO email_preferences (person_id, resumo_semanal) VALUES ($1, false)", [bia]);
    const r1 = await enviarResumoSemanal(db(), { modo: "ensaio", app, enviar: null }, "atrasadas", hoje);
    const meus = await owner.query("SELECT kind, task_count FROM notification_emails WHERE to_address LIKE '%@email-teste.invalid' ORDER BY kind");
    expect(meus.rows).toEqual([{ kind: "semanal_atrasadas", task_count: 1 }]);
    expect(r1.emails).toBeGreaterThanOrEqual(1);
    await enviarResumoSemanal(db(), { modo: "ensaio", app, enviar: null }, "atrasadas", hoje);
    expect((await owner.query("SELECT 1 FROM notification_emails WHERE person_id = $1", [ana])).rows).toHaveLength(1);
    await enviarResumoSemanal(db(), { modo: "ensaio", app, enviar: null }, "semana", hoje);
    expect((await owner.query("SELECT kind FROM notification_emails WHERE person_id = $1 ORDER BY kind", [ana])).rows.map((x) => x.kind)).toEqual(["semanal_atrasadas", "semanal_semana"]);
  });
});
