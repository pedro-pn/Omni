import { BusinessCalendar } from "@omni/core";
import { createPool, createWorkerDb, migrate, schema } from "@omni/db";
import { FiltroAppError, type Evento, type NovoRegistroQualidade, type Relatorio } from "@omni/integrations/filtroapp";
import { and, eq, like } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { processarEventos } from "../sync/filtroapp-eventos.ts";
import { syncRelatorios } from "../sync/filtroapp-relatorios.ts";
import { planejarAgenda, publicarPerguntas } from "./agenda.ts";
import { enviarDesvios } from "./desvios.ts";

/** IA do ciclo da missão no banco real (omni_test). Missões 7xxx são deste arquivo. */

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

describe.skipIf(!available)("IA do ciclo da missão", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let missionId: string;
  let pessoaId: string;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    const p = await owner.query<{ id: string }>(
      `INSERT INTO people (email, display_name) VALUES ('lider.7001.' || gen_random_uuid() || '@filtrovali.com.br', 'Pessoa IA') RETURNING id`,
    );
    pessoaId = p.rows[0]!.id;
  });

  beforeEach(async () => {
    await owner.query("DELETE FROM ai_deviations WHERE mission_id IN (SELECT id FROM missions WHERE code LIKE '7%')");
    await owner.query("DELETE FROM ai_questions WHERE mission_id IN (SELECT id FROM missions WHERE code LIKE '7%')");
    await owner.query("DELETE FROM missions WHERE code LIKE '7%'");
    await owner.query("DELETE FROM function_assignments WHERE function_code = 'qualidade'");
    const m = await owner.query<{ id: string }>(
      `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at, stage, planned_mobilization_date, executed_at_headquarters)
       VALUES ('7001', 'ia-7001', 'Porto Norte', true, now(), 'PREPARATION', '2026-11-09', false) RETURNING id`,
    );
    missionId = m.rows[0]!.id;
    await owner.query(
      `INSERT INTO mission_responsibles (mission_id, role, name, email, filtroapp_updated_at) VALUES
       ($1, 'LEADER', 'Líder Sete', 'lider7@filtrovali.com.br', now()), ($1, 'PLANNER', 'Gestor Sete', 'gestor7@filtrovali.com.br', now())`,
      [missionId],
    );
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), worker?.end()]);
  });

  const perguntas = (db: ReturnType<typeof createWorkerDb>) =>
    db.select().from(schema.aiQuestions).where(eq(schema.aiQuestions.missionId, missionId));

  it("planeja D-5 e D-1 da mobilização uma vez só", async () => {
    const db = createWorkerDb(worker);
    await planejarAgenda(db, cal, sp("2026-10-28T10:00:00"));
    await planejarAgenda(db, cal, sp("2026-10-28T10:15:00"));
    const lista = await perguntas(db);
    expect(lista.map((q) => q.flow).sort()).toEqual(["mob_d1", "mob_d5"]);
    expect(lista.every((q) => q.status === "agendada")).toBe(true);
  });

  it("data de mobilização mudou no filtroAPP: cancela as antigas e agenda as novas", async () => {
    const db = createWorkerDb(worker);
    await planejarAgenda(db, cal, sp("2026-10-28T10:00:00"));
    await owner.query("UPDATE missions SET planned_mobilization_date = '2026-11-16' WHERE id = $1", [missionId]);
    const r = await planejarAgenda(db, cal, sp("2026-10-28T10:15:00"));
    expect(r.criadas).toBe(2);
    const lista = await perguntas(db);
    expect(lista.filter((q) => q.status === "cancelada").map((q) => q.dedupeKey).sort()).toEqual([
      `mob_d1:${missionId}:2026-11-09`,
      `mob_d5:${missionId}:2026-11-09`,
    ]);
  });

  it("publica no Interno só na janela útil, endereçada ao líder de projetos, uma vez", async () => {
    const db = createWorkerDb(worker);
    await planejarAgenda(db, cal, sp("2026-10-28T10:00:00"));

    expect((await publicarPerguntas(db, cal, sp("2026-10-30T07:30:00"))).publicadas).toBe(0); // antes das 8h
    expect((await publicarPerguntas(db, cal, sp("2026-10-31T10:00:00"))).publicadas).toBe(0); // sábado

    const r = await publicarPerguntas(db, cal, sp("2026-10-30T08:05:00"));
    expect(r.publicadas).toBe(1);
    const [q] = (await perguntas(db)).filter((x) => x.flow === "mob_d5");
    expect(q?.status).toBe("enviada");
    const [msg] = await db.select().from(schema.missionMessages).where(eq(schema.missionMessages.id, q!.messageId!));
    expect(msg).toMatchObject({ kind: "ia", channel: "interno", authorPersonId: null });
    expect(msg!.body).toMatch(/^Líder Sete, faltam 5 dias úteis para a mobilização da Missão 7001 - Porto Norte \(09\/11\/2026\)/);

    expect((await publicarPerguntas(db, cal, sp("2026-10-30T08:10:00"))).publicadas).toBe(0);
  });

  it("'não' com nova data agenda a retomada 1 dia útil antes da nova data", async () => {
    const db = createWorkerDb(worker);
    await planejarAgenda(db, cal, sp("2026-10-28T10:00:00"));
    await owner.query(
      `UPDATE ai_questions SET status = 'respondida', answer = '{"opcao":"nao","nova_data":"2026-11-12"}', answered_at = now()
        WHERE mission_id = $1 AND flow = 'mob_d1'`,
      [missionId],
    );
    await planejarAgenda(db, cal, sp("2026-11-06T09:00:00"));
    const [retomada] = (await perguntas(db)).filter((q) => q.dedupeKey === `mob_d1:${missionId}:2026-11-12`);
    expect(retomada?.status).toBe("agendada");
    expect(retomada?.dueAt.toISOString()).toBe("2026-11-11T11:00:00.000Z");
  });

  async function desvioPendente() {
    const db = createWorkerDb(worker);
    await planejarAgenda(db, cal, sp("2026-10-28T10:00:00"));
    const [q] = (await perguntas(db)).filter((x) => x.flow === "mob_d1");
    await owner.query(
      `INSERT INTO ai_deviations (question_id, mission_id, request, created_by) VALUES ($1, $2, $3, $4)`,
      [
        q!.id,
        missionId,
        JSON.stringify({
          type: "DESVIO",
          projectCode: "7001",
          eventDate: "2026-11-06",
          description: "Missão 7001: mobilização não confirmada.",
          impact: "MEDIO",
          externalRef: { system: "omni", url: "https://omni.filtrovali.com.br/", reference: q!.id },
        }),
        pessoaId,
      ],
    );
    return db;
  }

  const ultimaMensagemIA = async (db: ReturnType<typeof createWorkerDb>) => {
    const rows = await db
      .select()
      .from(schema.missionMessages)
      .where(and(eq(schema.missionMessages.missionId, missionId), eq(schema.missionMessages.kind, "ia")));
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1)?.body ?? "";
  };

  it("modo de ensaio registra o desvio sem enviar e marca Qualidade e gestor", async () => {
    const db = await desvioPendente();
    const r = await enviarDesvios(db, null, cal, sp("2026-11-06T09:00:00"));
    expect(r.ensaio).toBeGreaterThanOrEqual(1); // o banco de teste é compartilhado: confira o próprio desvio
    const [d] = await db.select().from(schema.aiDeviations).where(eq(schema.aiDeviations.missionId, missionId));
    expect(d?.status).toBe("ensaio");
    expect(await ultimaMensagemIA(db)).toMatch(/^Qualidade \(função vaga\) e Gestor Sete: desvio registrado a partir da resposta acima \(escrita no filtroAPP desligada/);
  });

  it("modo ativo com a função Qualidade vaga não envia e avisa", async () => {
    const db = await desvioPendente();
    const chamadas: unknown[] = [];
    const r = await enviarDesvios(
      db,
      {
        escrita: "real",
        criarRegistroQualidade: async (c) => (
          chamadas.push(c),
          { simulado: false, resultado: { id: "x", number: "D-1/26", status: "EM_TRIAGEM", createdAt: new Date().toISOString() } }
        ),
      },
      cal,
      sp("2026-11-06T09:00:00"),
    );
    expect(r.falhas).toBeGreaterThanOrEqual(1);
    expect(chamadas).toHaveLength(0);
    expect(await ultimaMensagemIA(db)).toMatch(/função Qualidade está vaga/);
  });

  it("modo ativo envia com o e-mail de quem ocupa a Qualidade e a chave do pedido", async () => {
    const db = await desvioPendente();
    const q = await owner.query<{ id: string; email: string }>(
      `INSERT INTO people (email, display_name) VALUES ('qualidade.' || gen_random_uuid() || '@filtrovali.com.br', 'Pessoa da Qualidade') RETURNING id, email`,
    );
    await owner.query(`INSERT INTO function_assignments (function_code, person_id, starts_on) VALUES ('qualidade', $1, '2026-01-01')`, [q.rows[0]!.id]);

    const enviados: Array<{ corpo: NovoRegistroQualidade; chave: string }> = [];
    const r = await enviarDesvios(
      db,
      {
        escrita: "real",
        criarRegistroQualidade: async (corpo, chave) => {
          enviados.push({ corpo, chave });
          return { simulado: false, resultado: { id: "q1", number: "D-012/26", status: "EM_TRIAGEM", createdAt: new Date().toISOString() } };
        },
      },
      cal,
      sp("2026-11-06T09:00:00"),
    );
    expect(r.enviados).toBeGreaterThanOrEqual(1);
    const [d] = await db.select().from(schema.aiDeviations).where(eq(schema.aiDeviations.missionId, missionId));
    expect(d).toMatchObject({ status: "enviado", filtroappNumber: "D-012/26" });
    expect(enviados[0]!.chave).toBe(d!.idempotencyKey);
    expect(enviados[0]!.corpo.actionOwnerEmail).toBe(q.rows[0]!.email);
    expect(await ultimaMensagemIA(db)).toMatch(/Pessoa da Qualidade \(Qualidade\) e Gestor Sete: desvio D-012\/26 aberto/);
  });

  it("modo simulado: o filtroAPP valida e nada é gravado", async () => {
    const db = await desvioPendente();
    const q = await owner.query<{ id: string }>(
      `INSERT INTO people (email, display_name) VALUES ('q3.' || gen_random_uuid() || '@filtrovali.com.br', 'Q3') RETURNING id`,
    );
    await owner.query(`INSERT INTO function_assignments (function_code, person_id, starts_on) VALUES ('qualidade', $1, '2026-01-01')`, [q.rows[0]!.id]);
    const r = await enviarDesvios(
      db,
      { escrita: "simulada", criarRegistroQualidade: async () => ({ simulado: true, previa: { simulated: true } }) },
      cal,
      sp("2026-11-06T09:00:00"),
    );
    expect(r.simulados).toBeGreaterThanOrEqual(1);
    const [d] = await db.select().from(schema.aiDeviations).where(eq(schema.aiDeviations.missionId, missionId));
    expect(d).toMatchObject({ status: "simulado", filtroappNumber: null });
    expect(await ultimaMensagemIA(db)).toMatch(/simulação — o filtroAPP aceitaria este desvio/);
  });

  it("erro de validação do filtroAPP não fica repetindo", async () => {
    const db = await desvioPendente();
    const q = await owner.query<{ id: string }>(
      `INSERT INTO people (email, display_name) VALUES ('q2.' || gen_random_uuid() || '@filtrovali.com.br', 'Q2') RETURNING id`,
    );
    await owner.query(`INSERT INTO function_assignments (function_code, person_id, starts_on) VALUES ('qualidade', $1, '2026-01-01')`, [q.rows[0]!.id]);
    await enviarDesvios(
      db,
      {
        escrita: "real",
        criarRegistroQualidade: async () => {
          throw new FiltroAppError("filtroAPP respondeu 422 (ACTION_OWNER_NOT_FOUND)", 422, "ACTION_OWNER_NOT_FOUND");
        },
      },
      cal,
      sp("2026-11-06T09:00:00"),
    );
    const [d] = await db.select().from(schema.aiDeviations).where(eq(schema.aiDeviations.missionId, missionId));
    expect(d).toMatchObject({ status: "falhou", attempts: 5 });
  });

  // ---------------------------------------------------------------- ciclo depois da execução

  const PAYLOAD = JSON.stringify({ missao: { codigo: "7001", titulo: "Missão 7001 - Porto Norte" } });
  async function respondida(flow: string, answer: object, answeredAt: string, destino = '{"funcao":"medicao"}') {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO ai_questions (mission_id, flow, dedupe_key, due_at, status, addressed_to, payload, answer, answered_at)
       VALUES ($1, $2, $3, $5, 'respondida', $6, $4, $7, $5) RETURNING id`,
      [missionId, flow, `teste:${flow}:${missionId}:${answeredAt}`, PAYLOAD, answeredAt, destino, JSON.stringify(answer)],
    );
    return rows[0]!.id;
  }

  it("cobra RDO não recebido só de missão que usa RDO e com a cópia dos relatórios em dia", async () => {
    const db = createWorkerDb(worker);
    await owner.query(
      "UPDATE missions SET stage = 'EXECUTION', planned_mobilization_date = NULL, actual_mobilization_date = '2026-10-01', started_at = '2026-10-02' WHERE id = $1",
      [missionId],
    );
    const agora = sp("2026-11-06T09:00:00");
    const relatoriosSincronizados = (quando: Date) =>
      owner.query(
        `INSERT INTO sync_state (source, resource, last_success_at) VALUES ('filtroapp', 'relatorios', $1)
         ON CONFLICT (source, resource) DO UPDATE SET last_success_at = $1`,
        [quando],
      );
    const rdoAtrasado = async () => (await perguntas(db)).filter((q) => q.flow === "rdo_atrasado" && q.status === "agendada");

    // Sem nenhum RDO no filtroAPP: a missão não usa RDO, não cobra
    await relatoriosSincronizados(new Date(agora.getTime() - 30 * 60_000));
    await planejarAgenda(db, cal, agora);
    expect(await rdoAtrasado()).toEqual([]);

    await owner.query(
      `INSERT INTO reports (id, mission_id, report_type, status, report_date, filtroapp_updated_at) VALUES ('rel-7001-a', $1, 'RDO', 'APPROVED', '2026-11-04', now())
       ON CONFLICT (id) DO NOTHING`,
      [missionId],
    );
    // Cópia dos relatórios de 5 h atrás: pode ter chegado depois, não cobra
    await relatoriosSincronizados(new Date(agora.getTime() - 5 * 3_600_000));
    await planejarAgenda(db, cal, agora);
    expect(await rdoAtrasado()).toEqual([]);

    await relatoriosSincronizados(new Date(agora.getTime() - 30 * 60_000));
    await planejarAgenda(db, cal, agora);
    expect((await rdoAtrasado()).map((q) => q.dedupeKey)).toEqual([`rdo_atrasado:${missionId}:2026-11-05`]);
    await owner.query("DELETE FROM reports WHERE id = 'rel-7001-a'");
  });

  it("pergunta à função Medição no fim em campo e libera o Interno para a função", async () => {
    const db = createWorkerDb(worker);
    await owner.query(
      "UPDATE missions SET stage = 'POST_JOB', planned_mobilization_date = NULL, field_completion_date = '2026-11-13' WHERE id = $1",
      [missionId],
    );
    await planejarAgenda(db, cal, sp("2026-11-13T10:00:00"));
    expect((await perguntas(db)).map((q) => q.flow)).toEqual(["medicao"]);
    await publicarPerguntas(db, cal, sp("2026-11-13T10:05:00"));
    const acesso = await db.select().from(schema.missionFunctionAccess).where(eq(schema.missionFunctionAccess.missionId, missionId));
    expect(acesso.map((a) => a.functionCode)).toEqual(["medicao"]);
    expect(await ultimaMensagemIA(db)).toMatch(/^Medição \(função vaga\), a operação da Missão 7001 - Porto Norte terminou em campo em 13\/11\/2026/);
  });

  it("aprovação → faturamento → pagamentos; 'tudo fechado' encerra o ciclo e cancela o que estava agendado", async () => {
    const db = createWorkerDb(worker);
    await owner.query("UPDATE missions SET stage = 'FINAL_MEASUREMENT', planned_mobilization_date = NULL WHERE id = $1", [missionId]);

    await respondida("aprovacao", { opcao: "total" }, "2026-11-16T12:00:00Z");
    await planejarAgenda(db, cal, sp("2026-11-16T10:00:00"));
    const [fat] = (await perguntas(db)).filter((q) => q.flow === "faturamento");
    expect(fat).toMatchObject({ status: "agendada", addressedTo: { funcao: "faturamento" } });

    await respondida("faturamento", { opcao: "emitida" }, "2026-11-16T15:00:00Z", '{"funcao":"faturamento"}');
    await planejarAgenda(db, cal, sp("2026-11-16T12:30:00"));
    const [pag] = (await perguntas(db)).filter((q) => q.flow === "pagamentos");
    // 5 dias úteis após 16/11, pulando 20/11 (Consciência Negra): 24/11 às 8h
    expect(pag?.dueAt.toISOString()).toBe("2026-11-24T11:00:00.000Z");

    await respondida("pagamentos", { opcao: "concluido" }, "2026-11-24T12:00:00Z", '{"funcao":"faturamento"}');
    await planejarAgenda(db, cal, sp("2026-11-24T09:30:00"));
    const [m] = await db.select().from(schema.missions).where(eq(schema.missions.id, missionId));
    expect(m!.cycleClosedAt?.toISOString()).toBe("2026-11-24T12:00:00.000Z");
    expect(await ultimaMensagemIA(db)).toMatch(/^Ciclo da missão encerrado no Omni/);
    expect((await perguntas(db)).filter((q) => q.status === "agendada")).toEqual([]);

    // De novo: não repete o aviso nem cria perguntas
    await planejarAgenda(db, cal, sp("2026-11-24T09:45:00"));
    const avisos = await db
      .select()
      .from(schema.missionMessages)
      .where(and(eq(schema.missionMessages.missionId, missionId), like(schema.missionMessages.body, "Ciclo da missão encerrado%")));
    expect(avisos).toHaveLength(1);
  });

  it("saldo não medido marca também o Gerente comercial e libera o Interno para as funções marcadas", async () => {
    const db = createWorkerDb(worker);
    const q = await respondida("aprovacao", { opcao: "parcial", motivo: "Cliente glosou 2 dias" }, "2026-11-16T12:00:00Z");
    await owner.query(`INSERT INTO ai_deviations (question_id, mission_id, request, created_by) VALUES ($1, $2, '{"type":"DESVIO"}', $3)`, [
      q,
      missionId,
      pessoaId,
    ]);
    await enviarDesvios(db, null, cal, sp("2026-11-16T10:00:00"));
    expect(await ultimaMensagemIA(db)).toMatch(/^Qualidade \(função vaga\), Gestor Sete e Gerente comercial \(função vaga\): desvio registrado/);
    const acesso = await db.select().from(schema.missionFunctionAccess).where(eq(schema.missionFunctionAccess.missionId, missionId));
    expect(acesso.map((a) => a.functionCode).sort()).toEqual(["gerente_comercial", "qualidade"]);
  });
});

describe.skipIf(!available)("eventos e relatórios do filtroAPP", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
  });

  beforeEach(async () => {
    await owner.query("DELETE FROM sync_state WHERE resource IN ('eventos', 'relatorios')");
    await owner.query("DELETE FROM missions WHERE code LIKE '7%'");
    await owner.query(
      `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ('7101', 'ev-7101', 'Cliente', true, now())`,
    );
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), worker?.end()]);
  });

  const evento = (type: string): Evento => ({
    id: `evt_${type}`,
    type,
    occurredAt: "2026-10-29T12:00:00.000Z",
    projectId: "ev-7101",
    projectCode: "7101",
    resource: type.split(".")[0]!,
    resourceId: "r",
  });

  it("evento de RDO dispara só os relatórios e guarda o cursor depois", async () => {
    const db = createWorkerDb(worker);
    const chamadas: string[] = [];
    const r = await processarEventos(
      db,
      { listEventos: async () => ({ itens: [evento("rdo.devolvido"), evento("rdo.aprovado")], nextCursor: "c2", hasMore: false }) },
      { missoes: async () => chamadas.push("missoes"), relatorios: async () => chamadas.push("relatorios") },
    );
    expect(r.eventos).toBe(2);
    expect(chamadas).toEqual(["relatorios"]);
    const [estado] = await db.select().from(schema.syncState).where(eq(schema.syncState.resource, "eventos"));
    expect(estado?.cursor).toBe("c2");
  });

  it("cursor vencido: conferência completa e recomeço", async () => {
    const db = createWorkerDb(worker);
    const chamadas: string[] = [];
    const r = await processarEventos(
      db,
      { listEventos: async () => { throw new FiltroAppError("410", 410, "CURSOR_EXPIRED"); } },
      { missoes: async () => chamadas.push("missoes"), relatorios: async (o) => chamadas.push(`relatorios:${o?.forcarCompleta}`) },
    );
    expect(r.reiniciado).toBe(true);
    expect(chamadas).toEqual(["missoes", "relatorios:true"]);
  });

  it("sincroniza relatórios ligados às missões e ignora projeto desconhecido", async () => {
    const db = createWorkerDb(worker);
    const relatorio = (id: string, projectId: string, status: Relatorio["status"]): Relatorio => ({
      id,
      projectId,
      projectCode: "7101",
      reportType: "RDO",
      reportNumber: "82",
      sequenceNumber: 82,
      status,
      reportDate: "2026-10-26T00:00:00.000Z",
      daytimeWorkedMinutes: 480,
      nighttimeWorkedMinutes: 0,
      totalOvertimeMinutes: 60,
      dailyDescription: "Flushing da linha 3",
      overtimeReason: null,
      submittedAt: "2026-10-26T20:00:00.000Z",
      approvedAt: null,
      returnedAt: status === "RETURNED" ? "2026-10-27T12:00:00.000Z" : null,
      signedAt: null,
      clientReleasedAt: null,
      updatedAt: "2026-10-27T12:00:00.000Z",
    });
    const r = await syncRelatorios(db, {
      listRelatorios: async () => [relatorio("rel-7101-1", "ev-7101", "RETURNED"), relatorio("rel-x", "projeto-desconhecido", "APPROVED")],
    });
    expect(r).toMatchObject({ completa: true, gravados: 1, ignorados: 1 });
    const [gravado] = await db.select().from(schema.reports).where(like(schema.reports.id, "rel-7101%"));
    expect(gravado).toMatchObject({ status: "RETURNED", reportDate: "2026-10-26", workedMinutes: 480 });
  });
});
