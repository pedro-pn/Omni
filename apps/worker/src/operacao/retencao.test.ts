import { randomUUID } from "node:crypto";

import { createPool, createWorkerDb, migrate } from "@omni/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { aplicarRetencao, MAX_TENTATIVAS } from "./retencao.ts";

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

/**
 * Retenção dos dados de negócio (E15, migration 0081): vence só o que passou do prazo; arquivos no
 * SharePoint vão para a fila na mesma transação e o worker apaga de vez.
 */
describe.skipIf(!available)("retenção dos dados de negócio", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  const ids: Record<string, string> = {};
  const q1 = async (texto: string, valores: unknown[] = []) => (await owner.query<{ id: string }>(texto, valores)).rows[0]!.id;

  async function missao(nome: string, ativa: boolean, encerrada: string | null) {
    ids[nome] = await q1(
      `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at, cycle_closed_at)
       VALUES ($1, $2, 'Cliente', $3, now(), now() - $4::interval) RETURNING id`,
      [String(9_000 + Math.floor(Math.random() * 999)), `ret-${tag}-${nome}`, ativa, encerrada],
    );
    const msg = await q1("INSERT INTO mission_messages (mission_id, channel, body) VALUES ($1, 'interno', $2) RETURNING id", [ids[nome], `msg ${tag} ${nome}`]);
    await owner.query("INSERT INTO mission_message_files (message_id, name, mime, size, sp_drive_id, sp_item_id) VALUES ($1, 'a.pdf', 'application/pdf', 1, 'drive', $2)", [msg, `canal-${tag}-${nome}`]);
    const pergunta = await q1(
      "INSERT INTO ai_questions (mission_id, flow, dedupe_key, due_at, addressed_to, message_id) VALUES ($1, 'teste', $2, now(), '[]', $3) RETURNING id",
      [ids[nome], `ret-${tag}-${nome}`, msg],
    );
    await owner.query("INSERT INTO ai_deviations (question_id, mission_id, request, created_by) VALUES ($1, $2, '{}', $3)", [pergunta, ids[nome], ids.ativa_pessoa]);
    const email = await q1("INSERT INTO mail_messages (internet_message_id, received_at) VALUES ($1, now() - interval '6 years') RETURNING id", [`<ret-${tag}-${nome}>`]);
    await owner.query("INSERT INTO mail_message_missions (message_id, mission_id, motivo, detalhe) VALUES ($1, $2, 'numero', 'teste')", [email, ids[nome]]);
    const reuniao = await q1("INSERT INTO meetings (ical_uid, starts_at, ends_at) VALUES ($1, now() - interval '6 years', now() - interval '6 years') RETURNING id", [`ret-${tag}-${nome}`]);
    await owner.query("INSERT INTO meeting_missions (meeting_id, mission_id, motivo, detalhe) VALUES ($1, $2, 'numero', 'teste')", [reuniao, ids[nome]]);
  }

  async function tarefa(nome: string, dono: string) {
    const t = await q1("INSERT INTO tasks (content, created_by, owner_person_id) VALUES ($1, $2, $2) RETURNING id", [`ret ${tag} ${nome}`, dono]);
    await owner.query("INSERT INTO task_attachments (task_id, name, mime, size, sp_drive_id, sp_item_id) VALUES ($1, 'a.pdf', 'application/pdf', 1, 'drive', $2)", [t, `tarefa-${tag}-${nome}`]);
  }

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    const pessoa = (nome: string) => q1("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`ret-${nome}-${tag}@filtrovali.com.br`, nome]);
    ids.ativa_pessoa = await pessoa("ativa");
    ids.saiu_ha_tempo = await pessoa("saiu-ha-tempo");
    ids.saiu_agora = await pessoa("saiu-agora");

    await missao("vencida", false, "6 years");
    await missao("recente", false, "1 year");
    await missao("ativa", true, null);
    // Inativas sem data de encerramento (o filtroAPP não manda): contam de quando ficaram inativas (0083).
    await missao("inativa-velha", false, null);
    await missao("inativa-nova", false, null);
    await owner.query("UPDATE missions SET inativada_em = now() - interval '6 years' WHERE id = $1", [ids["inativa-velha"]]);

    // Desativação: o gatilho marca a data; a de 3 anos atrás é ajustada à mão.
    await owner.query("UPDATE people SET active = false WHERE id = ANY($1::uuid[])", [[ids.saiu_ha_tempo, ids.saiu_agora]]);
    await owner.query("UPDATE people SET deactivated_at = now() - interval '3 years' WHERE id = $1", [ids.saiu_ha_tempo]);
    await tarefa("pessoal-velha", ids.saiu_ha_tempo!);
    await tarefa("pessoal-de-quem-saiu-agora", ids.saiu_agora!);

    const numero = await q1(
      "INSERT INTO whatsapp_numbers (instance_name, label, purpose, owner_person_id) VALUES ($1, 'Retenção', 'outro', $2) RETURNING id",
      [`omni-ret${tag}`, ids.ativa_pessoa],
    );
    const chat = await q1("INSERT INTO whatsapp_chats (number_id, jid, is_group) VALUES ($1, '5547999990000@s.whatsapp.net', false) RETURNING id", [numero]);
    await owner.query(
      `INSERT INTO whatsapp_messages (chat_id, wa_id, from_me, kind, sent_at) VALUES
         ($1, $2, false, 'texto', now() - interval '6 years'), ($1, $3, false, 'texto', now())`,
      [chat, `velha-${tag}`, `nova-${tag}`],
    );
    ids.chat = chat;
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM arquivos_para_apagar WHERE sp_item_id LIKE $1", [`%-${tag}-%`]);
    await Promise.all([owner?.end(), worker?.end()]);
  });

  const conta = async (texto: string, valores: unknown[]) => (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${texto}`, valores)).rows[0]!.n;
  const estado = async () => ({
    mensagens: (await owner.query("SELECT body FROM mission_messages WHERE body LIKE $1 ORDER BY 1", [`msg ${tag} %`])).rows.map((r) => r.body.split(" ")[2]),
    perguntas: await conta("ai_questions WHERE dedupe_key LIKE $1", [`ret-${tag}-%`]),
    emails: await conta("mail_messages WHERE internet_message_id LIKE $1", [`<ret-${tag}-%`]),
    reunioes: await conta("meetings WHERE ical_uid LIKE $1", [`ret-${tag}-%`]),
    whatsapp: (await owner.query("SELECT wa_id FROM whatsapp_messages WHERE chat_id = $1 ORDER BY 1", [ids.chat])).rows.map((r) => r.wa_id),
    tarefas: (await owner.query("SELECT content FROM tasks WHERE content LIKE $1 ORDER BY 1", [`ret ${tag} %`])).rows.map((r) => r.content.split(" ")[2]),
    fila: (await owner.query("SELECT sp_item_id FROM arquivos_para_apagar WHERE sp_item_id LIKE $1 ORDER BY 1", [`%-${tag}-%`])).rows.map((r) => r.sp_item_id),
  });

  it("o gatilho marca quando a missão fica inativa e limpa se ela volta", async () => {
    const data = async () => (await owner.query("SELECT inativada_em FROM missions WHERE id = $1", [ids.ativa])).rows[0].inativada_em;
    expect(await data()).toBeNull();
    await owner.query("UPDATE missions SET is_active = false WHERE id = $1", [ids.ativa]);
    expect(await data()).not.toBeNull();
    await owner.query("UPDATE missions SET is_active = true WHERE id = $1", [ids.ativa]);
    expect(await data()).toBeNull();
    // Missão que já chega inativa do filtroAPP também é marcada.
    expect((await owner.query("SELECT inativada_em FROM missions WHERE id = $1", [ids["inativa-nova"]])).rows[0].inativada_em).not.toBeNull();
  });

  it("o gatilho marca e desmarca a desativação", async () => {
    const data = async () => (await owner.query("SELECT deactivated_at FROM people WHERE id = $1", [ids.saiu_agora])).rows[0].deactivated_at;
    expect(await data()).not.toBeNull();
    await owner.query("UPDATE people SET active = true WHERE id = $1", [ids.saiu_agora]);
    expect(await data()).toBeNull();
    await owner.query("UPDATE people SET active = false WHERE id = $1", [ids.saiu_agora]);
    expect(await data()).not.toBeNull();
  });

  it("ensaio só conta; real apaga só o vencido e põe os arquivos na fila; o worker apaga no SharePoint", async () => {
    const antes = await estado();
    const contagem = await aplicarRetencao(createWorkerDb(worker), "ensaio", null);
    expect(contagem.aplicado).toBe(false);
    expect(contagem.missoes_vencidas).toBeGreaterThanOrEqual(1);
    expect(await estado()).toEqual(antes);

    const apagados: string[] = [];
    const sharepoint = {
      apagarDefinitivo: async (_drive: string, item: string) => {
        if (item.includes(tag)) apagados.push(item);
      },
    };
    const r = await aplicarRetencao(createWorkerDb(worker), "real", sharepoint);
    expect(r.aplicado).toBe(true);
    const depois = await estado();
    expect(depois.mensagens).toEqual(["ativa", "inativa-nova", "recente"]);
    expect(depois.perguntas).toBe(3);
    expect(depois.emails).toBe(3);
    expect(depois.reunioes).toBe(3);
    expect(depois.whatsapp).toEqual([`nova-${tag}`]);
    expect(depois.tarefas).toEqual(["pessoal-de-quem-saiu-agora"]);
    // Os dois arquivos vencidos foram apagados no SharePoint e saíram da fila.
    expect(apagados.sort()).toEqual([`canal-${tag}-inativa-velha`, `canal-${tag}-vencida`, `tarefa-${tag}-pessoal-velha`]);
    expect(depois.fila).toEqual([]);
  });

  it("arquivo que não sai fica na fila; depois de 5 tentativas o job falha (vira erro do sistema)", async () => {
    await owner.query("INSERT INTO arquivos_para_apagar (sp_drive_id, sp_item_id, origem, tentativas) VALUES ('drive', $1, 'canal', $2)", [`teimoso-${tag}-x`, MAX_TENTATIVAS - 1]);
    const falha = { apagarDefinitivo: async (_d: string, item: string) => { if (item.includes(tag)) throw new Error("Graph 503"); } };
    await expect(aplicarRetencao(createWorkerDb(worker), "real", falha)).rejects.toThrow(/não foram apagados depois de 5 tentativas/);
    const [linha] = (await owner.query("SELECT tentativas, ultimo_erro FROM arquivos_para_apagar WHERE sp_item_id = $1", [`teimoso-${tag}-x`])).rows;
    expect(linha).toEqual({ tentativas: MAX_TENTATIVAS, ultimo_erro: "Graph 503" });
  });

  it("a tela não vê a fila nem chama a retenção", async () => {
    const app = createPool(urls.owner.replace("omni_owner:omni_owner_dev", "omni_app:omni_app_dev"), 1);
    try {
      await expect(app.query("SELECT count(*) FROM arquivos_para_apagar")).rejects.toThrow(/permission denied/);
      await expect(app.query("SELECT app.aplicar_retencao(false)")).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
});
