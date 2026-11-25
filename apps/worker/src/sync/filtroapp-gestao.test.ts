import { BusinessCalendar } from "@omni/core";
import { createPool, createWorkerDb, migrate, schema, withPerson } from "@omni/db";
import type { CustoProjeto, PontoSemana, SemanaAcompanhamento, ServicosDoProjeto } from "@omni/integrations/filtroapp";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { janelaDeSemanas, pedeSemanas, syncCustos, syncSemanas, syncServicos, type FonteGestao } from "./filtroapp-gestao.ts";

/** Gestão do filtroAPP (B6) no banco real (omni_test). Missão 7301 é deste arquivo. */

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

const PROJETO = "fa-7301";
const cal = new BusinessCalendar();
const AGORA = new Date("2026-11-04T15:00:00Z"); // quarta; semana de 02/11

const semana = (weekStart: string, extra: Partial<SemanaAcompanhamento> = {}): SemanaAcompanhamento => ({
  projectId: PROJETO,
  projectCode: "7301",
  weekStart,
  avancoInicio: 40,
  avancoFim: 43,
  metaPontos: 5,
  metaDefinidaPor: "PROJETO",
  revisao: null,
  updatedAt: "2026-11-04T12:00:00.000Z",
  ...extra,
});
const ponto = (weekStart: string): PontoSemana => ({
  projectId: PROJETO,
  projectCode: "7301",
  weekStart,
  minutosNormais: 4800,
  minutosExtra70: 120.5,
  minutosExtra100: 60,
  minutosNoturnos: 0,
  pessoas: 3,
  atualizadoEm: "2026-11-04T12:00:00.000Z",
});
const custo = (projectId = PROJETO): CustoProjeto => ({
  projectId,
  projectCode: "7301",
  orcamento: { precoVenda: "100000.00", custoPrevisto: "60000.00", margemPrevista: 40, diasPrevistos: 30 },
  custoRealizado: {
    total: "39000.00",
    porCategoria: [
      { codigo: "MAO_DE_OBRA", rotulo: "Mão de obra", valor: "30000.00" },
      { codigo: "COMPRAS_OMIE", rotulo: "Compras", valor: "9000.00" },
    ],
    ate: "2026-11-04",
  },
  avancoFisico: 45,
  consumoDoCusto: 65,
  currency: "BRL",
  atualizadoEm: "2026-11-04T12:00:00.000Z",
});

function fonte(dados: { semanas: SemanaAcompanhamento[]; ponto: PontoSemana[]; custos: CustoProjeto[] }, janelas: Array<{ from: string; to: string }>): FonteGestao {
  return {
    listSemanasAcompanhamento: async (j) => (janelas.push(j), dados.semanas),
    listPontoSemanas: async () => dados.ponto,
    listCustos: async () => dados.custos,
  };
}

describe.skipIf(!available)("Gestão do filtroAPP (B6)", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let app: pg.Pool;
  let missionId: string;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    app = createPool(urls.app, 2);
    await owner.query("DELETE FROM missions WHERE code = '7301'");
    await owner.query("DELETE FROM sync_state WHERE source = 'filtroapp' AND resource IN ('semanas', 'custos')");
    missionId = (
      await owner.query<{ id: string }>(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ('7301', $1, 'Cliente G', true, now()) RETURNING id`,
        [PROJETO],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), worker?.end(), app?.end()]);
  });

  it("janela: as 4 últimas segundas até a semana de hoje", () => {
    expect(janelaDeSemanas(cal, AGORA)).toEqual({ from: "2026-10-12", to: "2026-11-02" });
    expect(janelaDeSemanas(cal, AGORA, 12)).toEqual({ from: "2026-08-17", to: "2026-11-02" });
  });

  it("semanas e ponto: grava pela missão, ignora projeto desconhecido e tira da janela o que sumiu", async () => {
    const db = createWorkerDb(worker);
    const janelas: Array<{ from: string; to: string }> = [];
    const dados = {
      semanas: [
        semana("2026-10-26", { revisao: { concluidaEm: "2026-10-31T18:00:00.000Z", pendencias: 0, itens: [{ codigo: "WEEKLY_TARGET", rotulo: "Meta", ok: true }] } }),
        semana("2026-11-02", {
          meta: {
            situacao: "BELOW",
            rotuloSituacao: "Abaixo da meta",
            emAndamento: true,
            periodoInicio: "2026-10-30",
            periodoFim: "2026-11-05",
            regra: "ALL",
            cenario: null,
            atingimentoPct: 66.5,
            itens: [
              { tipo: "SERVICE", servico: null, rotuloServico: null, unidade: "M", rotuloUnidade: "m", base: "PER_PRODUCTIVE_DAY", valorCadastrado: 27, planejado: 108, realizado: 71.82, diferenca: -36.18, resultado: "BELOW", pendenciasBase: [], descricao: "27 m por colaborador e dia" },
            ],
            colaboradoresPorDia: [],
          },
        }),
        { ...semana("2026-11-02"), projectId: "projeto-desconhecido" },
      ],
      ponto: [ponto("2026-10-26"), ponto("2026-11-02")],
      custos: [],
    };
    const r1 = await syncSemanas(db, fonte(dados, janelas), cal, { now: () => AGORA });
    // A primeira do dia lê 12 semanas (evolução na aba Gestão); as seguintes, 4.
    expect(r1.completa).toBe(true);
    expect(janelas[0]).toEqual({ from: "2026-08-17", to: "2026-11-02" });
    expect(r1.semanas).toMatchObject({ gravados: 2, ignorados: 1 });
    const linhas = await db.select().from(schema.missionWeeklyProgress).where(eq(schema.missionWeeklyProgress.missionId, missionId));
    const passada = linhas.find((l) => l.weekStart === "2026-10-26");
    expect(passada).toMatchObject({ avancoInicio: 40, avancoFim: 43, metaPontos: 5, revisaoPendencias: 0 });
    expect(passada?.revisaoConcluidaEm).not.toBeNull();
    expect(passada?.meta).toBeNull(); // linha sem meta
    expect(linhas.find((l) => l.weekStart === "2026-11-02")?.meta).toMatchObject({ situacao: "BELOW", itens: [{ unidade: "M", realizado: 71.82 }] });
    const [h] = await db.select().from(schema.missionTimesheetWeeks).where(eq(schema.missionTimesheetWeeks.weekStart, "2026-10-26"));
    expect(h).toMatchObject({ minutosExtra70: 120.5, pessoas: 3 });

    // A semana passada some do ponto (ex.: passou a ter uma pessoa só): sai do Omni também.
    dados.ponto = [ponto("2026-11-02")];
    const r2 = await syncSemanas(db, fonte(dados, janelas), cal, { now: () => AGORA });
    expect(r2.completa).toBe(false);
    expect(janelas[1]).toEqual({ from: "2026-10-12", to: "2026-11-02" });
    expect(r2.ponto.removidos).toBe(1);
  });

  it("custos: completo, remove o que sumiu; a tela não lê a tabela e só gestão vê pela função", async () => {
    const db = createWorkerDb(worker);
    const r = await syncCustos(db, fonte({ semanas: [], ponto: [], custos: [custo(), custo("projeto-desconhecido")] }, []));
    expect(r).toMatchObject({ gravados: 1, ignorados: 1 });
    const [c] = await db.select().from(schema.missionCosts).where(eq(schema.missionCosts.missionId, missionId));
    expect(c).toMatchObject({ custoPrevisto: 60000, custoTotal: 39000, consumoDoCusto: 65, avancoFisico: 45, custoAte: "2026-11-04" });
    expect(c?.custoPorCategoria).toEqual([
      { codigo: "MAO_DE_OBRA", rotulo: "Mão de obra", valor: 30000 },
      { codigo: "COMPRAS_OMIE", rotulo: "Compras", valor: 9000 },
    ]);

    const pessoa = async (perfil: string) => {
      const id = (
        await owner.query<{ id: string }>(`INSERT INTO people (email, display_name) VALUES ('g.' || gen_random_uuid() || '@filtrovali.com.br', 'G') RETURNING id`)
      ).rows[0]!.id;
      await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [id, perfil]);
      return id;
    };
    const [gerente, operacao] = [await pessoa("gerente"), await pessoa("operacao")];
    const ler = (quem: string, consulta: ReturnType<typeof sql>) => withPerson(app, quem, (d) => d.execute<Record<string, unknown>>(consulta));
    await expect(ler(gerente, sql`SELECT custo_total FROM mission_costs`)).rejects.toThrow();
    const funcao = sql`SELECT consumo_do_custo, custo_total FROM app.custos_missoes() WHERE mission_id = ${missionId}`;
    expect((await ler(gerente, funcao)).rows[0]).toMatchObject({ consumo_do_custo: 65, custo_total: "39000.00" });
    expect((await ler(operacao, funcao)).rows).toHaveLength(0);
    // Semanas: gestão vê; quem não vê o Interno da missão, não.
    const semanas = sql`SELECT week_start FROM mission_weekly_progress WHERE mission_id = ${missionId}`;
    expect((await ler(gerente, semanas)).rows.length).toBeGreaterThan(0);
    expect((await ler(operacao, semanas)).rows).toHaveLength(0);

    const r2 = await syncCustos(db, fonte({ semanas: [], ponto: [], custos: [] }, []));
    expect(r2.removidos).toBeGreaterThanOrEqual(1);
  });

  it("composição do avanço: substitui a cada leitura, remove o que sumiu; gestão vê, quem não vê o Interno não", async () => {
    const db = createWorkerDb(worker);
    const linha = (servicos: ServicosDoProjeto["servicos"], projectId = PROJETO): ServicosDoProjeto => ({
      projectId,
      projectCode: "7301",
      avancoTotal: 62.5,
      servicos,
      updatedAt: "2026-11-24T12:00:00.000Z",
    });
    const flushing = { escopo: "Escopo 1", servico: "FLUSHING", rotuloServico: "Flushing", equipamento: "UH-01", avancoPct: 80, unidade: "M", rotuloUnidade: "m", previsto: 120, realizado: 96, sistemas: 3 };
    const limpeza = { escopo: null, servico: "LIMPEZA_QUIMICA", rotuloServico: "Limpeza química", equipamento: null, avancoPct: 110, unidade: null, rotuloUnidade: null, previsto: null, realizado: null, sistemas: 2 };
    const fonteS = (linhas: ServicosDoProjeto[]) => ({ listServicos: async () => linhas });
    expect(await syncServicos(db, fonteS([linha([flushing, limpeza]), linha([], "projeto-desconhecido")]))).toMatchObject({ gravados: 1, ignorados: 1 });
    const ler = async () => (await db.select().from(schema.missionServiceProgress).where(eq(schema.missionServiceProgress.missionId, missionId)))[0];
    expect(await ler()).toMatchObject({ avancoTotal: 62.5, servicos: [flushing, limpeza] });
    // A leitura seguinte substitui (não acumula).
    await syncServicos(db, fonteS([linha([limpeza])]));
    expect((await ler())?.servicos).toEqual([limpeza]);
    // Quem lê: gestão sim; operação sem o Interno, não.
    const pessoa = async (perfil: string) => {
      const id = (
        await owner.query<{ id: string }>(`INSERT INTO people (email, display_name) VALUES ('s.' || gen_random_uuid() || '@filtrovali.com.br', 'S') RETURNING id`)
      ).rows[0]!.id;
      await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [id, perfil]);
      return id;
    };
    const consulta = sql`SELECT avanco_total FROM mission_service_progress WHERE mission_id = ${missionId}`;
    expect((await withPerson(app, await pessoa("gerente"), (d) => d.execute(consulta))).rows).toHaveLength(1);
    expect((await withPerson(app, await pessoa("operacao"), (d) => d.execute(consulta))).rows).toHaveLength(0);
    // Projeto que não veio na leitura completa perde a composição.
    expect((await syncServicos(db, fonteS([]))).removidos).toBeGreaterThanOrEqual(1);
    expect(await ler()).toBeUndefined();
  });

  it("eventos de meta e revisão pedem reler as semanas", () => {
    expect(pedeSemanas(["acompanhamento.meta_alterada"])).toBe(true);
    expect(pedeSemanas(["rdo.aprovado", "alocacao.alterada"])).toBe(false);
  });
});
