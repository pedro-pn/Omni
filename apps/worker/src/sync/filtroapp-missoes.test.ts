import { createPool, createWorkerDb, migrate, schema } from "@omni/db";
import type { Projeto, Responsavel, StatusColecao } from "@omni/integrations/filtroapp";
import { and, desc, eq, like } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FONTE, RECURSO, syncMissoes, type FonteMissoes } from "./filtroapp-missoes.ts";

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

// Códigos 8xxx são deste teste; o teste de RLS usa 9xxx.
function projeto(code: string, extra: Partial<Projeto> = {}): Projeto {
  return {
    id: `t-${code}`,
    code,
    name: `Cliente ${code}`,
    isActive: true,
    location: "Itajaí",
    clientSegment: "siderurgica",
    mobilizationDate: null,
    demobilizationDate: null,
    startDate: "2026-07-06T03:00:00.000Z",
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    clientName: `Cliente ${code} Ltda`,
    clientCnpj: "12345678000190",
    commercialProposalCode: "4216",
    endDate: null,
    includesSaturday: true,
    includesSunday: false,
    workdayHours: "09:00",
    weekendWorkdayHours: "08:00",
    executedAtHeadquarters: false,
    ...extra,
  };
}

function status(code: string, stage: string | null): StatusColecao {
  return {
    projectId: `t-${code}`,
    projectCode: code,
    workflowStarted: stage !== null,
    stage,
    workflowVersion: 3,
    plannedMobilizationDate: "2026-08-01",
    plannedExecutionStartDate: null,
    plannedExecutionEndDate: null,
    fieldCompletionDate: null,
    demobilizationDate: null,
    commercialReadiness: null,
    mobilizationReady: true,
    closureReady: false,
    openIssueCount: 1,
    criticalIssueCount: 0,
    progressPercent: 40,
    progressMethod: "SCOPE",
    closedAt: null,
    commercialExpectedMobilizationDate: "2026-07-20",
    commercialExpectedStartDate: null,
    commercialExpectedDurationDays: 65,
    actualMobilizationDate: "2026-08-01",
  };
}

function responsavel(code: string, role: Responsavel["role"], email: string | null): Responsavel {
  return {
    projectId: `t-${code}`,
    projectCode: code,
    role,
    userId: role === "FIELD_OPERATOR" ? null : `u-${role}`,
    collaboratorId: role === "FIELD_OPERATOR" ? "col-1" : null,
    name: `${role} ${code}`,
    email,
    updatedAt: "2026-10-28T10:00:00.000Z",
  };
}

class FonteFalsa implements FonteMissoes {
  projetos: Projeto[] = [];
  status: StatusColecao[] = [];
  responsaveis: Responsavel[] = [];
  chamadas: Array<{ updatedSince?: Date }> = [];
  async listProjetos(params: { updatedSince?: Date } = {}) {
    this.chamadas.push(params);
    return this.projetos.filter((p) => !params.updatedSince || new Date(p.updatedAt) >= params.updatedSince);
  }
  async listStatus() {
    return this.status;
  }
  async listResponsaveis() {
    return this.responsaveis;
  }
}

describe.skipIf(!available)("syncMissoes", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
  });

  beforeEach(async () => {
    await owner.query("DELETE FROM missions WHERE code LIKE '8%'");
    await owner.query("DELETE FROM sync_state WHERE source = $1 AND resource = $2", [FONTE, RECURSO]);
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), worker?.end()]);
  });

  it("primeira execução é completa: grava projeto, cliente, regime e status", async () => {
    const fonte = new FonteFalsa();
    fonte.projetos = [projeto("8001"), projeto("8002", { isActive: false })];
    fonte.status = [status("8001", "EXECUTION")];

    const db = createWorkerDb(worker);
    const r = await syncMissoes(db, fonte);
    expect(r).toMatchObject({ completa: true, projetos: 2, status: 1 });
    expect(fonte.chamadas[0]).toEqual({});

    const [m] = await db.select().from(schema.missions).where(eq(schema.missions.code, "8001"));
    expect(m).toMatchObject({
      clientName: "Cliente 8001",
      clientLegalName: "Cliente 8001 Ltda",
      clientCnpj: "12345678000190",
      includesSaturday: true,
      includesSunday: false,
      stage: "EXECUTION",
      workflowStarted: true,
      progressPercent: 40,
      commercialExpectedDurationDays: 65,
      actualMobilizationDate: "2026-08-01",
    });
    const [inativa] = await db.select().from(schema.missions).where(eq(schema.missions.code, "8002"));
    expect(inativa?.statusSyncedAt).toBeNull(); // status só para ativas
  });

  it("depois é incremental, com sobreposição de 5 minutos", async () => {
    const fonte = new FonteFalsa();
    fonte.projetos = [projeto("8003", { updatedAt: "2026-10-27T10:00:00.000Z" })];
    const db = createWorkerDb(worker);
    await syncMissoes(db, fonte, () => new Date("2026-10-28T08:00:00Z"));

    fonte.projetos.push(projeto("8004", { updatedAt: "2026-10-28T09:00:00.000Z" }));
    const r = await syncMissoes(db, fonte, () => new Date("2026-10-28T09:30:00Z"));
    expect(r.completa).toBe(false);
    expect(fonte.chamadas[1]?.updatedSince?.toISOString()).toBe("2026-10-27T09:55:00.000Z");
    const rows = await db.select().from(schema.missions).where(like(schema.missions.code, "800%"));
    expect(rows.map((x) => x.code).sort()).toEqual(["8003", "8004"]);
  });

  it("a reconciliação completa diária inativa o que sumiu do filtroAPP", async () => {
    const fonte = new FonteFalsa();
    fonte.projetos = [projeto("8005"), projeto("8006")];
    const db = createWorkerDb(worker);
    await syncMissoes(db, fonte, () => new Date("2026-10-27T08:00:00Z"));

    fonte.projetos = [projeto("8005")];
    const r = await syncMissoes(db, fonte, () => new Date("2026-10-28T08:30:00Z"));
    expect(r.completa).toBe(true);
    const [sumiu] = await db.select().from(schema.missions).where(eq(schema.missions.code, "8006"));
    expect(sumiu?.isActive).toBe(false);
  });

  it("missão ativa fora da coleção de status fica sem etapa", async () => {
    const fonte = new FonteFalsa();
    fonte.projetos = [projeto("8007")];
    const db = createWorkerDb(worker);
    await syncMissoes(db, fonte);
    const [m] = await db.select().from(schema.missions).where(eq(schema.missions.code, "8007"));
    expect(m).toMatchObject({ workflowStarted: null, stage: null });
    expect(m?.statusSyncedAt).not.toBeNull();
  });

  it("grava os responsáveis e apaga o papel que saiu", async () => {
    const fonte = new FonteFalsa();
    fonte.projetos = [projeto("8008")];
    fonte.responsaveis = [
      responsavel("8008", "LEADER", "Lider@Filtrovali.com.br"),
      responsavel("8008", "PLANNER", "gestor@filtrovali.com.br"),
      responsavel("8008", "FIELD_OPERATOR", null),
      responsavel("9999", "LEADER", "orfao@filtrovali.com.br"), // projeto que o Omni não conhece: ignorado
    ];
    const db = createWorkerDb(worker);
    const r = await syncMissoes(db, fonte);
    expect(r.responsaveis).toBe(3);

    const [m] = await db.select().from(schema.missions).where(eq(schema.missions.code, "8008"));
    const lista = await db.select().from(schema.missionResponsibles).where(eq(schema.missionResponsibles.missionId, m!.id));
    expect(lista.map((x) => x.role).sort()).toEqual(["FIELD_OPERATOR", "LEADER", "PLANNER"]);
    expect(lista.find((x) => x.role === "LEADER")?.email).toBe("lider@filtrovali.com.br");

    fonte.responsaveis = fonte.responsaveis.filter((x) => x.role !== "PLANNER");
    await syncMissoes(db, fonte);
    const depois = await db.select().from(schema.missionResponsibles).where(eq(schema.missionResponsibles.missionId, m!.id));
    expect(depois.map((x) => x.role).sort()).toEqual(["FIELD_OPERATOR", "LEADER"]);
  });

  it("falha fica registrada em sync_runs e não move o ponto de retomada", async () => {
    const fonte = new FonteFalsa();
    fonte.listProjetos = async () => {
      throw new Error("filtroAPP respondeu 403 (SCOPE_DENIED) em /projetos");
    };
    const db = createWorkerDb(worker);
    await expect(syncMissoes(db, fonte)).rejects.toThrow(/403/);
    const [ultima] = await db
      .select()
      .from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.source, FONTE), eq(schema.syncRuns.resource, RECURSO)))
      .orderBy(desc(schema.syncRuns.id))
      .limit(1);
    expect(ultima).toMatchObject({ status: "erro" });
    expect(ultima?.error).toContain("SCOPE_DENIED");
    const estado = await db.select().from(schema.syncState).where(eq(schema.syncState.resource, RECURSO));
    expect(estado).toHaveLength(0);
  });
});
