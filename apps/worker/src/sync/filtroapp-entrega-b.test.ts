import { createPool, createWorkerDb, migrate, schema, withPerson } from "@omni/db";
import type { Alocacao, Descarga, Medicao, Nota, Pendencia, Romaneio } from "@omni/integrations/filtroapp";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recursosDosEventos, syncEntregaB, type FonteEntregaB } from "./filtroapp-entrega-b.ts";

/** Entrega B do filtroAPP no banco real (omni_test). Missão 7201 é deste arquivo. */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  worker: process.env.TEST_DATABASE_URL_WORKER ?? "postgres://omni_worker:omni_worker_dev@localhost:5433/omni_test",
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

const PROJETO = "fa-7201";
const medicao = (extra: Partial<Medicao> = {}): Medicao => ({
  projectId: PROJETO,
  projectCode: "7201",
  preparedAt: "2026-11-02T12:00:00.000Z",
  sentAt: "2026-11-03T12:00:00.000Z",
  approvedAt: null,
  situacao: "ENVIADA",
  saldoPendente: null,
  executedAmount: "1000.00",
  measuredAmount: "900.00",
  approvedAmount: null,
  currency: "BRL",
  updatedAt: "2026-11-03T12:00:00.000Z",
  ...extra,
});
const nota = (id: string, projectId = PROJETO): Nota => ({
  id,
  projectId,
  projectCode: "7201",
  tipo: "NFSE",
  numero: id.toUpperCase(),
  serie: "1",
  dataEmissao: "2026-11-10T13:00:00.000Z",
  valor: "900.00",
  situacaoRecebimento: "EM_ABERTO",
  updatedAt: "2026-11-10T13:00:00.000Z",
});
const romaneio: Romaneio = {
  id: "rom-7201",
  projectId: PROJETO,
  projectCode: "7201",
  tipo: "SAIDA",
  data: "2026-11-01T12:00:00.000Z",
  emitidoEm: "2026-11-01T12:30:00.000Z",
  quantidadeItens: 12,
  pesoCarga: "1500.500",
  unidadePeso: "kg",
  updatedAt: "2026-11-01T12:30:00.000Z",
};
const pendencia: Pendencia = {
  projectId: PROJETO,
  projectCode: "7201",
  aPagar: { quantidade: 0, valorEmAberto: "0.00", proximoVencimento: null },
  aReceber: { quantidade: 1, valorEmAberto: "900.00", proximoVencimento: "2026-12-10T03:00:00.000Z" },
  atualizadoEm: "2026-11-10T13:00:00.000Z",
};

function fonte(dados: { notas: Nota[]; alocacoes?: Alocacao[] }, chamadas: Array<{ recurso: string; updatedSince?: Date }>): FonteEntregaB {
  const lista =
    <T,>(recurso: string, itens: () => T[]) =>
    async (p: { updatedSince?: Date } = {}) => {
      chamadas.push({ recurso, ...p });
      return itens();
    };
  return {
    listMedicoes: lista("medicoes", () => [medicao()]),
    listNotas: lista("notas", () => dados.notas),
    listRomaneios: lista("romaneios", () => [romaneio]),
    listPendencias: lista("pendencias", () => [pendencia]),
    listDescargas: lista("descargas", () => [] as Descarga[]),
    listRegistrosQualidade: lista("qualidade", () => [
      {
        id: "q-7201",
        number: "D-001/26",
        type: "DESVIO",
        status: "ABERTO",
        impact: "MEDIO",
        eventDate: "2026-11-05",
        project: { id: PROJETO, code: "7201" },
        nature: { name: "Operação" },
        actionDeadline: null,
        recurrence: { recurrent: false },
        deletedAt: null,
        updatedAt: "2026-11-05T12:00:00.000Z",
      },
      { id: "q-geral", number: "L-001/26", type: "LICAO_APRENDIDA", status: "DIVULGADO", impact: null, eventDate: null, project: null, nature: null, actionDeadline: null, recurrence: null, deletedAt: null, updatedAt: "2026-11-05T12:00:00.000Z" },
    ]),
    listCondicoes: lista("condicoes", () => [
      { projectId: PROJETO, projectCode: "7201", permanenciaPrevistaDias: 30, diariaStandByEquipamento: "2000.00", currency: "BRL" as const, updatedAt: "2026-11-01T12:00:00.000Z" },
    ]),
    listAlocacoes: lista("alocacoes", () => dados.alocacoes ?? []),
  };
}

const alocacao = (id: string, extra: Partial<Alocacao> = {}): Alocacao => ({
  id,
  projectId: PROJETO,
  projectCode: "7201",
  collaboratorId: `col-${id}`,
  funcao: "Técnico",
  mobilizacao: "2026-11-02",
  desmobilizacao: null,
  updatedAt: "2026-11-02T12:00:00.000Z",
  deletedAt: null,
  ...extra,
});

describe.skipIf(!available)("Entrega B do filtroAPP", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let app: pg.Pool;
  let missionId: string;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    app = createPool(urls.app, 2);
    await owner.query("DELETE FROM missions WHERE code = '7201'");
    await owner.query(
      "DELETE FROM sync_state WHERE resource IN ('medicoes', 'notas', 'romaneios', 'pendencias', 'descargas', 'qualidade', 'condicoes', 'alocacoes')",
    );
    missionId = (
      await owner.query<{ id: string }>(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ('7201', $1, 'Cliente B', true, now()) RETURNING id`,
        [PROJETO],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), worker?.end(), app?.end()]);
  });

  it("completa grava tudo pela missão e ignora projeto desconhecido; incremental usa updatedSince; completa remove o que sumiu", async () => {
    const db = createWorkerDb(worker);
    const dados = {
      notas: [nota("n1"), nota("n2"), nota("x", "projeto-desconhecido")],
      alocacoes: [alocacao("a1"), alocacao("a2", { deletedAt: "2026-11-03T12:00:00.000Z" })],
    };
    const chamadas: Array<{ recurso: string; updatedSince?: Date }> = [];
    const r1 = await syncEntregaB(db, fonte(dados, chamadas), { now: () => new Date("2026-11-10T14:00:00Z") });
    expect(r1.notas).toMatchObject({ completa: true, gravados: 2, ignorados: 1 });
    expect(r1.qualidade).toMatchObject({ gravados: 1, ignorados: 1 }); // sem projeto fica de fora
    const [m] = await db.select().from(schema.missionMeasurements).where(eq(schema.missionMeasurements.missionId, missionId));
    expect(m).toMatchObject({ situacao: "ENVIADA", executedAmount: 1000, measuredAmount: 900, approvedAmount: null });
    const [p] = await db.select().from(schema.missionPending).where(eq(schema.missionPending.missionId, missionId));
    expect(p).toMatchObject({ aPagarQtd: 0, aPagarValor: 0, aReceberQtd: 1, aReceberValor: 900 });
    const [c] = await db.select().from(schema.missionConditions).where(eq(schema.missionConditions.missionId, missionId));
    expect(c).toMatchObject({ permanenciaPrevistaDias: 30, diariaStandBy: 2000 });
    const aloc = await db.select().from(schema.missionAllocations).where(eq(schema.missionAllocations.missionId, missionId));
    expect(aloc.map((a) => [a.id, a.deletedAt !== null]).sort()).toEqual([
      ["a1", false],
      ["a2", true], // exclusão lógica fica guardada
    ]);

    chamadas.length = 0;
    await syncEntregaB(db, fonte(dados, chamadas), { recursos: ["notas"], now: () => new Date("2026-11-10T14:30:00Z") });
    expect(chamadas[0]?.updatedSince?.toISOString()).toBe("2026-11-10T12:55:00.000Z"); // marca d'água − 5 min

    dados.notas = [nota("n1")];
    const r3 = await syncEntregaB(db, fonte(dados, chamadas), { recursos: ["notas"], forcarCompleta: true });
    expect(r3.notas?.removidos).toBe(1);
    const restantes = await db.select().from(schema.missionInvoices).where(eq(schema.missionInvoices.missionId, missionId));
    expect(restantes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("a tela não lê valores financeiros", async () => {
    const pessoa = (
      await owner.query<{ id: string }>(
        `INSERT INTO people (email, display_name) VALUES ('fin.' || gen_random_uuid() || '@filtrovali.com.br', 'Fin') RETURNING id`,
      )
    ).rows[0]!.id;
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'operacao')", [pessoa]);
    // Operação só vê a missão a que está associada (0045): aqui, liberada à mão.
    await owner.query("INSERT INTO mission_viewers (mission_id, person_id, added_by) VALUES ($1, $2, $2)", [missionId, pessoa]);
    const ler = (consulta: ReturnType<typeof sql>) => withPerson(app, pessoa, (db) => db.execute(consulta));
    expect((await ler(sql`SELECT situacao FROM mission_measurements WHERE mission_id = ${missionId}`)).rows).toHaveLength(1);
    expect((await ler(sql`SELECT numero, situacao_recebimento FROM mission_invoices WHERE mission_id = ${missionId}`)).rows).toHaveLength(1);
    expect((await ler(sql`SELECT permanencia_prevista_dias FROM mission_conditions WHERE mission_id = ${missionId}`)).rows).toHaveLength(1);
    for (const consulta of [
      sql`SELECT approved_amount FROM mission_measurements`,
      sql`SELECT valor FROM mission_invoices`,
      sql`SELECT a_receber_valor FROM mission_pending`,
      sql`SELECT diaria_stand_by FROM mission_conditions`,
    ]) {
      await expect(ler(consulta)).rejects.toThrow();
    }
  });

  it("eventos do feed apontam o recurso certo", () => {
    expect(
      recursosDosEventos(["nota.emitida", "rdo.aprovado", "medicao.alterada", "nota.recebimento_alterado", "descarga.confirmada", "alocacao.alterada"]).sort(),
    ).toEqual(["alocacoes", "descargas", "medicoes", "notas"]);
  });
});
