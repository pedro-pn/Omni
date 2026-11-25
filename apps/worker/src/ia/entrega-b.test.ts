import { BusinessCalendar } from "@omni/core";
import { createPool, createWorkerDb, migrate, schema } from "@omni/db";
import { FiltroAppError, type NovaDescarga } from "@omni/integrations/filtroapp";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { planejarAgenda } from "./agenda.ts";
import { enviarDescargas, type FonteDescargas } from "./descargas.ts";

/** IA com os dados da Entrega B do filtroAPP, no banco real (omni_test). Missão 7301 é deste arquivo. */

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
const sp = (iso: string) => new Date(`${iso}-03:00`);

describe.skipIf(!available)("IA com os dados do filtroAPP (Entrega B)", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let missionId: string;
  let lider: string;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    lider = (
      await owner.query<{ id: string }>(
        `INSERT INTO people (email, display_name) VALUES ('lider.7301.' || gen_random_uuid() || '@filtrovali.com.br', 'Líder Sete') RETURNING id`,
      )
    ).rows[0]!.id;
  });

  beforeEach(async () => {
    await owner.query("DELETE FROM ai_unloadings WHERE mission_id IN (SELECT id FROM missions WHERE code = '7301')");
    await owner.query("DELETE FROM ai_questions WHERE mission_id IN (SELECT id FROM missions WHERE code = '7301')");
    await owner.query("DELETE FROM missions WHERE code = '7301'");
    missionId = (
      await owner.query<{ id: string }>(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at, stage, actual_mobilization_date, executed_at_headquarters)
         VALUES ('7301', 'fa-7301', 'Porto Leste', true, now(), 'MOBILIZATION', '2026-11-04', false) RETURNING id`,
      )
    ).rows[0]!.id;
    await owner.query(
      `INSERT INTO mission_romaneios (id, mission_id, tipo, data, emitido_em, quantidade_itens, filtroapp_updated_at)
       VALUES ('rom-7301', $1, 'SAIDA', '2026-11-03T12:00:00Z', '2026-11-03T13:00:00Z', 8, now())`,
      [missionId],
    );
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), worker?.end()]);
  });

  const perguntas = (db: ReturnType<typeof createWorkerDb>) => db.select().from(schema.aiQuestions).where(eq(schema.aiQuestions.missionId, missionId));

  it("romaneio de saída recente → pergunta de descarga; com descarga total no filtroAPP, cancela", async () => {
    const db = createWorkerDb(worker);
    await planejarAgenda(db, cal, sp("2026-11-03T15:00:00"));
    const [q] = (await perguntas(db)).filter((x) => x.flow === "descarga");
    expect(q).toMatchObject({ status: "agendada", payload: { romaneio: { id: "rom-7301", data: "2026-11-03" } } });

    await owner.query(
      `INSERT INTO mission_unloadings (id, romaneio_id, mission_id, tipo, confirmada_em, confirmada_por_email, filtroapp_updated_at)
       VALUES ('desc-7301', 'rom-7301', $1, 'TOTAL', now(), 'lider@filtrovali.com.br', now())`,
      [missionId],
    );
    await planejarAgenda(db, cal, sp("2026-11-03T16:00:00"));
    const [depois] = (await perguntas(db)).filter((x) => x.flow === "descarga");
    expect(depois?.status).toBe("cancelada");
    await owner.query("DELETE FROM mission_unloadings WHERE id = 'desc-7301'");
  });

  it("envio da descarga: simulada, recusada pelo filtroAPP (pessoa sem acesso) e já total", async () => {
    const db = createWorkerDb(worker);
    await planejarAgenda(db, cal, sp("2026-11-03T15:00:00"));
    const [q] = (await perguntas(db)).filter((x) => x.flow === "descarga");
    const pedido = async () => {
      await owner.query("DELETE FROM ai_unloadings WHERE question_id = $1", [q!.id]);
      await owner.query(
        `INSERT INTO ai_unloadings (question_id, mission_id, request, created_by) VALUES ($1, $2, $3, $4)`,
        [q!.id, missionId, JSON.stringify({ romaneioId: "rom-7301", tipo: "TOTAL", confirmadaEm: "2026-11-04T13:00:00.000Z" }), lider],
      );
    };
    const ultima = async () =>
      (
        await db
          .select()
          .from(schema.missionMessages)
          .where(and(eq(schema.missionMessages.missionId, missionId), eq(schema.missionMessages.kind, "ia")))
      )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .at(-1)?.body ?? "";
    const status = async () => (await db.select().from(schema.aiUnloadings).where(eq(schema.aiUnloadings.questionId, q!.id)))[0]?.status;

    const enviados: NovaDescarga[] = [];
    await pedido();
    const simulada: FonteDescargas = { escrita: "simulada", criarDescarga: async (c) => (enviados.push(c), { simulado: true, previa: {} }) };
    expect(await enviarDescargas(db, simulada, cal)).toMatchObject({ simuladas: 1 });
    expect(await status()).toBe("simulado");
    expect(enviados[0]).toMatchObject({ romaneioId: "rom-7301", tipo: "TOTAL", confirmadaPorEmail: expect.stringMatching(/^lider\.7301\./) });
    expect(await ultima()).toMatch(/simulação — o filtroAPP aceitaria a descarga total/);

    await pedido();
    const recusa: FonteDescargas = {
      escrita: "real",
      criarDescarga: async () => {
        throw new FiltroAppError("filtroAPP respondeu 422 (CONFIRMING_USER_NOT_ALLOWED)", 422, "CONFIRMING_USER_NOT_ALLOWED");
      },
    };
    await enviarDescargas(db, recusa, cal);
    expect(await status()).toBe("falhou");
    expect(await ultima()).toMatch(/Confirme pelo filtroAPP: Efetivo → missão → Ver romaneios/);

    await pedido();
    const jaTotal: FonteDescargas = {
      escrita: "real",
      criarDescarga: async () => {
        throw new FiltroAppError("filtroAPP respondeu 409", 409, "CONFLICT");
      },
    };
    await enviarDescargas(db, jaTotal, cal);
    expect(await status()).toBe("enviado");
  });

  it("ciclo encerra pelos dados: NF depois do fim em campo e Omie sem pendências", async () => {
    const db = createWorkerDb(worker);
    await owner.query("UPDATE missions SET stage = 'FINAL_MEASUREMENT', field_completion_date = '2026-11-02' WHERE id = $1", [missionId]);
    await owner.query(
      `INSERT INTO mission_invoices (id, mission_id, tipo, numero, data_emissao, situacao_recebimento, filtroapp_updated_at)
       VALUES ('nf-7301', $1, 'NFSE', '123', '2026-11-05T13:00:00Z', 'RECEBIDA', now())`,
      [missionId],
    );
    await owner.query(
      `INSERT INTO mission_pending (mission_id, a_pagar_qtd, a_pagar_valor, a_receber_qtd, a_receber_valor, filtroapp_updated_at)
       VALUES ($1, 0, 0, 1, NULL, now())`,
      [missionId],
    );
    await planejarAgenda(db, cal, sp("2026-11-06T09:00:00"));
    let [m] = await db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
    expect(m!.cycleClosedAt).toBeNull(); // a receber com saldo desconhecido: não fecha

    await owner.query("UPDATE mission_pending SET a_receber_qtd = 0, a_receber_valor = 0 WHERE mission_id = $1", [missionId]);
    await planejarAgenda(db, cal, sp("2026-11-06T09:15:00"));
    [m] = await db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
    expect(m!.cycleClosedAt).not.toBeNull();
    await owner.query("DELETE FROM mission_invoices WHERE id = 'nf-7301'");
    await owner.query("DELETE FROM mission_pending WHERE mission_id = $1", [missionId]);
  });

  it("uma pergunta de NF por missão, mesmo quando nasce dos dados e de uma resposta", async () => {
    const db = createWorkerDb(worker);
    await owner.query("UPDATE missions SET stage = 'FINAL_MEASUREMENT', field_completion_date = '2026-11-02' WHERE id = $1", [missionId]);
    await owner.query(
      `INSERT INTO mission_measurements (mission_id, situacao, sent_at, approved_at, saldo_pendente, filtroapp_updated_at)
       VALUES ($1, 'APROVADA', '2026-11-03T12:00:00Z', '2026-11-04T12:00:00Z', false, now())`,
      [missionId],
    );
    await owner.query(
      `INSERT INTO ai_questions (mission_id, flow, dedupe_key, due_at, status, addressed_to, payload, answer, answered_at)
       VALUES ($1, 'aprovacao', 'teste-aprovacao-7301', now(), 'respondida', '{"funcao":"medicao"}', '{"missao":{"codigo":"7301","titulo":"Missão 7301"}}',
               '{"opcao":"total"}', '2026-11-04T12:00:00Z')`,
      [missionId],
    );
    await planejarAgenda(db, cal, sp("2026-11-04T10:00:00"));
    const nf = (await perguntas(db)).filter((x) => x.flow === "faturamento" && x.status !== "cancelada");
    expect(nf).toHaveLength(1);
    await owner.query("DELETE FROM mission_measurements WHERE mission_id = $1", [missionId]);
  });
});
