import { BusinessCalendar } from "@omni/core";
import { createPool, createWorkerDb, migrate, schema } from "@omni/db";
import { LlmError, type Llm } from "@omni/integrations/openai";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { lerRdos } from "./leitura-rdos.ts";

/** Leitura dos RDOs no banco real (omni_test), com um LLM de mentira. Missão 7701 é deste arquivo. */

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
const AGORA = new Date("2026-11-09T10:00:00Z"); // segunda, 07:00 em São Paulo
const COM_PROBLEMA = "Flushing da linha de retorno. A bomba B-02 desarmou e ficou parada aguardando técnico até o fim do turno.";
const ROTINA = "Serviço executado conforme planejado, sem ocorrências. Filtragem do reservatório principal em andamento.";

function llmFalso(chamadas: string[], erro?: LlmError): Llm {
  return {
    async estruturado<T>(p: { entrada: string }) {
      chamadas.push(p.entrada);
      if (erro) throw erro;
      const pontos = p.entrada.includes("B-02")
        ? [
            { tipo: "equipamento_parado", resumo: "Bomba B-02 parada esperando técnico.", trecho: "A bomba B-02 desarmou e ficou parada aguardando técnico" },
            { tipo: "falta_material", resumo: "Inventado.", trecho: "faltou óleo novo" },
          ]
        : [];
      return { dados: { pontos } as T, modelo: "modelo-teste", tokensEntrada: 300, tokensSaida: 40, duracaoMs: 900 };
    },
  };
}

describe.skipIf(!available)("leitura dos RDOs", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let missao: string;
  const db = () => createWorkerDb(worker);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
  });

  beforeEach(async () => {
    await owner.query("DELETE FROM missions WHERE code = '7701'");
    missao = (
      await owner.query<{ id: string }>(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, includes_saturday, includes_sunday, workday_hours, filtroapp_updated_at)
         VALUES ('7701', 'lr-7701', 'Cliente L', true, false, false, '8h48', now()) RETURNING id`,
      )
    ).rows[0]!.id;
    const rdo = (id: string, data: string, texto: string, extra = "") =>
      owner.query(
        `INSERT INTO reports (id, mission_id, report_type, report_number, status, report_date, worked_minutes, daily_description, filtroapp_updated_at${extra ? ", overtime_minutes" : ""})
         VALUES ($1, $2, 'RDO', $3, 'APPROVED', $4, 528, $5, now()${extra ? `, ${extra}` : ""})`,
        [id, missao, id.slice(-2), data, texto],
      );
    await rdo("lr-rdo-01", "2026-11-06", COM_PROBLEMA); // sexta
    await rdo("lr-rdo-02", "2026-11-07", ROTINA); // sábado, regime sem sábado
    await rdo("lr-rdo-03", "2026-10-20", COM_PROBLEMA); // fora da janela
    await rdo("lr-rdo-04", "2026-11-08", "curto"); // texto curto demais
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), worker?.end()]);
  });

  it("lê os RDOs recentes uma vez só; aponta o regime sem IA; descarta citação inventada; cria a pergunta no horário útil", async () => {
    const chamadas: string[] = [];
    const r = await lerRdos(db(), llmFalso(chamadas), cal, { modelo: "modelo-teste", now: () => AGORA });
    expect(r).toMatchObject({ lidos: 2, comPontos: 2, perguntas: 2, erros: 0 });
    expect(chamadas).toHaveLength(2);

    const analises = await db().select().from(schema.rdoAnalyses).where(eq(schema.rdoAnalyses.missionId, missao));
    const por = new Map(analises.map((a) => [a.reportId, a]));
    expect(por.get("lr-rdo-01")!.points.map((p) => p.tipo)).toEqual(["equipamento_parado"]); // "faltou óleo novo" não está no texto
    expect(por.get("lr-rdo-02")!.points.map((p) => p.tipo)).toEqual(["fora_do_regime"]); // sábado, sem IA
    expect(por.has("lr-rdo-03") || por.has("lr-rdo-04")).toBe(false);

    const perguntas = await db().select().from(schema.aiQuestions).where(eq(schema.aiQuestions.missionId, missao));
    expect(perguntas.map((q) => q.flow)).toEqual(["rdo_leitura", "rdo_leitura"]);
    // Sem ORDER BY o Postgres pode devolver essas perguntas em qualquer ordem.
    expect(perguntas.every(q => q.dueAt.toISOString() === "2026-11-09T11:00:00.000Z")).toBe(true); // 08:00 em São Paulo
    expect(perguntas.some(q => JSON.stringify(q.payload).includes("Equipamento parado"))).toBe(true);

    // Registro da chamada: metadados, sem o texto do RDO.
    const registros = await db().select().from(schema.llmCalls).where(eq(schema.llmCalls.missionId, missao));
    expect(registros).toHaveLength(2);
    expect(JSON.stringify(registros)).not.toContain("bomba");

    // Segunda rodada: nada novo.
    expect((await lerRdos(db(), llmFalso(chamadas), cal, { modelo: "modelo-teste", now: () => AGORA })).lidos).toBe(0);
  });

  it("sem crédito na OpenAI: para a rodada e não marca o RDO como lido; sem LLM, só as regras do regime", async () => {
    const r = await lerRdos(db(), llmFalso([], new LlmError("sem crédito", 429, "credit_balance_exhausted")), cal, { modelo: "m", now: () => AGORA });
    expect(r).toMatchObject({ lidos: 0, erros: 1, parouSemCredito: true });
    expect(await db().select().from(schema.rdoAnalyses).where(eq(schema.rdoAnalyses.missionId, missao))).toEqual([]);

    const s = await lerRdos(db(), null, cal, { modelo: "m", now: () => AGORA });
    expect(s).toMatchObject({ lidos: 2, comPontos: 1, perguntas: 1 }); // só o sábado
    const [{ n }] = (await db().execute<{ n: number }>(sql`SELECT count(*)::int n FROM llm_calls WHERE mission_id = ${missao} AND outcome = 'ok'`)).rows as [{ n: number }];
    expect(n).toBe(0);
  });
});
