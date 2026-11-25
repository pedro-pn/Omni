import { BusinessCalendar } from "@omni/core";
import { createPool, createWorkerDb, migrate } from "@omni/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { detectarChegadas } from "./chegadas.ts";

/** "Chegamos" no grupo do WhatsApp, no banco real (omni_test). Missão 7601 e instância omni-chegadateste1 são deste arquivo. */

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
const cal = new BusinessCalendar();

describe.skipIf(!available)("chegada da equipe pelo grupo do WhatsApp", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let missao: string;
  let grupo: string;
  let n = 0;
  const mensagem = (texto: string, minutosAtras = 10, deMim = false) =>
    owner.query(
      `INSERT INTO whatsapp_messages (chat_id, wa_id, from_me, author_name, kind, body, sent_at) VALUES ($1, $2, $3, 'Josinaldo', 'texto', $4, now() - make_interval(mins => $5))`,
      [grupo, `CHEGADA-${++n}-${Date.now()}`, deMim, texto, minutosAtras],
    );
  const perguntas = () => owner.query("SELECT flow, payload, status FROM ai_questions WHERE mission_id = $1 ORDER BY created_at", [missao]).then((r) => r.rows);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
  });
  beforeEach(async () => {
    await owner.query("DELETE FROM ai_questions WHERE mission_id IN (SELECT id FROM missions WHERE code = '7601')");
    await owner.query("DELETE FROM whatsapp_messages WHERE chat_id IN (SELECT c.id FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id WHERE n.instance_name = 'omni-chegadateste1')");
    await owner.query("DELETE FROM whatsapp_chat_missions WHERE chat_id IN (SELECT c.id FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id WHERE n.instance_name = 'omni-chegadateste1')");
    await owner.query("DELETE FROM whatsapp_chats WHERE number_id IN (SELECT id FROM whatsapp_numbers WHERE instance_name = 'omni-chegadateste1')");
    await owner.query("DELETE FROM whatsapp_numbers WHERE instance_name = 'omni-chegadateste1'");
    await owner.query("DELETE FROM missions WHERE code = '7601'");
    missao = (
      await owner.query<{ id: string }>(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, stage, actual_mobilization_date, filtroapp_updated_at)
         VALUES ('7601', 'chegada-7601', 'Porto Norte', true, 'MOBILIZATION', current_date - 1, now()) RETURNING id`,
      )
    ).rows[0]!.id;
    const numero = (await owner.query<{ id: string }>("INSERT INTO whatsapp_numbers (instance_name, label, purpose, status) VALUES ('omni-chegadateste1', 'Teste', 'outro', 'desconectado') RETURNING id")).rows[0]!.id;
    grupo = (await owner.query<{ id: string }>("INSERT INTO whatsapp_chats (number_id, jid, is_group, name) VALUES ($1, '120363000000000001@g.us', true, 'Missão 7601') RETURNING id", [numero])).rows[0]!.id;
    await owner.query("INSERT INTO whatsapp_chat_missions (chat_id, mission_id) VALUES ($1, $2)", [grupo, missao]);
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM ai_questions WHERE mission_id = $1", [missao]);
    await Promise.all([owner?.end(), worker?.end()]);
  });

  it("'chegamos' de alguém do grupo vira uma pergunta ao líder de projetos, citando a mensagem; não repete no mesmo dia", async () => {
    await mensagem("Bom dia");
    await mensagem("Chegamos na portaria, onde descarrega?", 5);
    await mensagem("chegamos", 3, true); // a própria Filtrovali não conta
    expect((await detectarChegadas(createWorkerDb(worker), cal)).perguntas).toBe(1);
    const [q] = await perguntas();
    expect(q).toMatchObject({ flow: "chegada_grupo", status: "agendada", payload: { chegada: { autor: "Josinaldo", trecho: "Chegamos na portaria, onde descarrega?" } } });
    expect((await detectarChegadas(createWorkerDb(worker), cal)).perguntas).toBe(0);
  });

  it("não pergunta se a missão já começou em campo ou se a chegada já foi confirmada", async () => {
    await mensagem("Chegamos");
    await owner.query("UPDATE missions SET stage = 'EXECUTION', started_at = now() WHERE id = $1", [missao]);
    expect((await detectarChegadas(createWorkerDb(worker), cal)).perguntas).toBe(0);
    await owner.query("UPDATE missions SET stage = 'MOBILIZATION', started_at = NULL WHERE id = $1", [missao]);
    await owner.query(
      `INSERT INTO ai_questions (mission_id, flow, dedupe_key, due_at, status, addressed_to, payload, answer, answered_at)
       VALUES ($1, 'chegada_grupo', 'chegada_grupo:teste-confirmada', now(), 'respondida', '{"papel":"LEADER"}', '{}', '{"opcao":"todos"}', now())`,
      [missao],
    );
    expect((await detectarChegadas(createWorkerDb(worker), cal)).perguntas).toBe(0);
  });
});
