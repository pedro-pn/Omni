import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";
import { aiDeviations, aiQuestions, missionParticipantNotes, missionViewers, prismaFeedbackLog, rdoAnalyses, reports } from "./schema.ts";

/** Permissões das tabelas da IA (migrations 0006 e 0008). Missão 9201 é deste teste. */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
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

async function falha(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as Error & { cause?: Error },
  );
  expect(error, "deveria ter sido recusado").not.toBeNull();
  expect(`${error?.message} | ${error?.cause?.message ?? ""}`).toMatch(pattern);
}

describe.skipIf(!available)("permissões da IA", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let missionId: string;
  let lider: string;
  let fora: string;
  let semPerfil: string;
  let enviada: string;
  let agendada: string;
  const tag = randomUUID().slice(0, 6);

  async function pessoa(nome: string, perfil: string | null) {
    const { rows } = await owner.query<{ id: string }>(
      "INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id",
      [`${nome}-${tag}@filtrovali.com.br`, nome],
    );
    if (perfil) await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, perfil]);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 3);
    await owner.query("DELETE FROM ai_deviations WHERE mission_id IN (SELECT id FROM missions WHERE code = '9201')");
    await owner.query("DELETE FROM ai_questions WHERE mission_id IN (SELECT id FROM missions WHERE code = '9201')");
    await owner.query("DELETE FROM missions WHERE code = '9201'");
    missionId = (
      await owner.query<{ id: string }>(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ('9201', 'ia-9201', 'Cliente IA', true, now()) RETURNING id`,
      )
    ).rows[0]!.id;
    lider = await pessoa("lider", "lider_projetos");
    fora = await pessoa("fora", "operacao");
    semPerfil = await pessoa("semperfil", null);
    await owner.query(
      `INSERT INTO mission_responsibles (mission_id, role, name, email, filtroapp_updated_at) VALUES ($1, 'LEADER', 'Líder', $2, now())`,
      [missionId, `lider-${tag}@filtrovali.com.br`],
    );
    const q = await owner.query<{ id: string; status: string }>(
      `INSERT INTO ai_questions (mission_id, flow, dedupe_key, due_at, status, addressed_to) VALUES
       ($1, 'mob_d1', 'teste-enviada-${tag}', now(), 'enviada', '{"papel":"LEADER"}'),
       ($1, 'mob_d5', 'teste-agendada-${tag}', now(), 'agendada', '{"papel":"LEADER"}') RETURNING id, status`,
      [missionId],
    );
    enviada = q.rows.find((r) => r.status === "enviada")!.id;
    agendada = q.rows.find((r) => r.status === "agendada")!.id;
    await owner.query(
      `INSERT INTO reports (id, mission_id, report_type, status, report_date, filtroapp_updated_at) VALUES ('rel-9201-${tag}', $1, 'RDO', 'APPROVED', '2026-10-26', now())`,
      [missionId],
    );
  });

  afterAll(async () => {
    // Não deixar desvio pendente no banco compartilhado (o worker processaria nos testes dele).
    await owner?.query("DELETE FROM ai_deviations WHERE mission_id = $1", [missionId]);
    await owner?.query("DELETE FROM function_assignments WHERE person_id IN (SELECT id FROM people WHERE email LIKE $1)", [`%-${tag}@filtrovali.com.br`]);
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("só quem vê o Interno vê as perguntas", async () => {
    const doLider = await withPerson(app, lider, (db) => db.select().from(aiQuestions).where(eq(aiQuestions.missionId, missionId)));
    expect(doLider).toHaveLength(2);
    const deFora = await withPerson(app, fora, (db) => db.select().from(aiQuestions).where(eq(aiQuestions.missionId, missionId)));
    expect(deFora).toHaveLength(0);
  });

  it("quem não é do Interno não responde", async () => {
    const r = await withPerson(app, fora, (db) =>
      db
        .update(aiQuestions)
        .set({ status: "respondida", answer: { opcao: "sim" }, answeredBy: fora, answeredAt: new Date() })
        .where(eq(aiQuestions.id, enviada))
        .returning({ id: aiQuestions.id }),
    );
    expect(r).toHaveLength(0);
  });

  it("não se responde em nome de outra pessoa nem pergunta ainda não enviada", async () => {
    await falha(
      withPerson(app, lider, (db) =>
        db.update(aiQuestions).set({ status: "respondida", answer: { opcao: "sim" }, answeredBy: fora, answeredAt: new Date() }).where(eq(aiQuestions.id, enviada)),
      ),
      /row-level security/,
    );
    const r = await withPerson(app, lider, (db) =>
      db
        .update(aiQuestions)
        .set({ status: "respondida", answer: { opcao: "sim" }, answeredBy: lider, answeredAt: new Date() })
        .where(eq(aiQuestions.id, agendada))
        .returning({ id: aiQuestions.id }),
    );
    expect(r).toHaveLength(0);
  });

  it("a tela não altera outros campos da pergunta", async () => {
    await falha(
      withPerson(app, lider, (db) => db.update(aiQuestions).set({ dueAt: new Date() }).where(eq(aiQuestions.id, enviada))),
      /permission denied/,
    );
  });

  it("o líder responde em nome próprio; responder de novo não é possível", async () => {
    const r = await withPerson(app, lider, (db) =>
      db
        .update(aiQuestions)
        .set({ status: "respondida", answer: { opcao: "nao", motivo: "teste" }, answeredBy: lider, answeredAt: new Date() })
        .where(and(eq(aiQuestions.id, enviada), eq(aiQuestions.status, "enviada")))
        .returning({ id: aiQuestions.id }),
    );
    expect(r).toHaveLength(1);
    const deNovo = await withPerson(app, lider, (db) =>
      db
        .update(aiQuestions)
        .set({ status: "respondida", answer: { opcao: "sim" }, answeredBy: lider, answeredAt: new Date() })
        .where(eq(aiQuestions.id, enviada))
        .returning({ id: aiQuestions.id }),
    );
    expect(deNovo).toHaveLength(0);
  });

  it("desvio nasce só como pendente, por quem vê o Interno", async () => {
    const pedido = { questionId: enviada, missionId, request: { type: "DESVIO" } };
    await falha(
      withPerson(app, fora, (db) => db.insert(aiDeviations).values({ ...pedido, createdBy: fora })),
      /row-level security/,
    );
    await falha(
      withPerson(app, lider, (db) => db.insert(aiDeviations).values({ ...pedido, createdBy: lider, status: "enviado" })),
      /row-level security/,
    );
    await withPerson(app, lider, (db) => db.insert(aiDeviations).values({ ...pedido, createdBy: lider }));
  });

  it("relatórios: só quem vê a missão (0045)", async () => {
    expect(await withPerson(app, semPerfil, (db) => db.select().from(reports).where(eq(reports.missionId, missionId)))).toHaveLength(0);
    expect(await withPerson(app, fora, (db) => db.select().from(reports).where(eq(reports.missionId, missionId)))).toHaveLength(0);
    expect(await withPerson(app, lider, (db) => db.select().from(reports).where(eq(reports.missionId, missionId)))).toHaveLength(1);
  });

  it("quem vê a missão: diretoria, administração e gerentes todas; os demais só associados ou liberados (0045)", async () => {
    const ve = (quem: string) => withPerson(app, quem, (db) => db.execute<{ ok: boolean }>(sql`SELECT app.ve_missao(${missionId}::uuid) AS ok`)).then((r) => r.rows[0]!.ok);
    const admin = await pessoa("adm", "admin");
    const gerente = await pessoa("ger", "gerente");
    const campo = await pessoa("campo", "operacao");
    const alocado = await pessoa("alocado", "operacao");
    const liberado = await pessoa("liberado", "vendas");
    expect(await ve(admin)).toBe(true);
    expect(await ve(gerente)).toBe(true);
    expect(await ve(lider)).toBe(true); // líder de projetos (responsável no filtroAPP)
    for (const q of [fora, campo, alocado, liberado, semPerfil]) expect(await ve(q)).toBe(false);
    // Líder de campo no filtroAPP, pelo e-mail.
    await owner.query(`INSERT INTO mission_responsibles (mission_id, role, name, email, filtroapp_updated_at) VALUES ($1, 'FIELD_OPERATOR', 'Campo', $2, now())`, [missionId, `campo-${tag}@filtrovali.com.br`]);
    expect(await ve(campo)).toBe(true);
    // Alocado no Efetivo, pelo colaborador ligado à conta.
    await owner.query("UPDATE people SET filtroapp_collaborator_id = $2 WHERE id = $1", [alocado, `colab-${tag}`]);
    await owner.query("INSERT INTO mission_allocations (id, mission_id, collaborator_id, filtroapp_updated_at) VALUES ($1, $2, $3, now())", [`aloc-${tag}`, missionId, `colab-${tag}`]);
    expect(await ve(alocado)).toBe(true);
    // Liberado à mão: só diretoria e administração liberam.
    await falha(withPerson(app, gerente, (db) => db.insert(missionViewers).values({ missionId, personId: liberado, addedBy: gerente })), /row-level security/);
    await withPerson(app, admin, (db) => db.insert(missionViewers).values({ missionId, personId: liberado, addedBy: admin }));
    expect(await ve(liberado)).toBe(true);
    expect(await withPerson(app, liberado, (db) => db.select().from(reports).where(eq(reports.missionId, missionId)))).toHaveLength(1);
    await withPerson(app, admin, (db) => db.delete(missionViewers).where(eq(missionViewers.personId, liberado)));
    expect(await ve(liberado)).toBe(false);
    await owner.query("DELETE FROM mission_allocations WHERE id = $1", [`aloc-${tag}`]);
    await owner.query("DELETE FROM mission_responsibles WHERE mission_id = $1 AND role = 'FIELD_OPERATOR'", [missionId]);
  });

  it("leitura do RDO pela IA: só quem vê o Interno; a tela não grava", async () => {
    await owner.query(
      `INSERT INTO rdo_analyses (report_id, mission_id, prompt_version, points) VALUES ($1, $2, 'teste', '[{"tipo":"hora_extra","resumo":"Hora extra sem motivo","trecho":null}]')
       ON CONFLICT (report_id) DO NOTHING`,
      [`rel-9201-${tag}`, missionId],
    );
    const ler = (quem: string) => withPerson(app, quem, (db) => db.select().from(rdoAnalyses).where(eq(rdoAnalyses.missionId, missionId)));
    expect(await ler(lider)).toHaveLength(1);
    expect(await ler(fora)).toHaveLength(0);
    expect(await ler(semPerfil)).toHaveLength(0);
    await falha(
      withPerson(app, lider, (db) => db.update(rdoAnalyses).set({ points: [] }).where(eq(rdoAnalyses.missionId, missionId))),
      /permission denied/,
    );
  });

  it("participantes completados à mão: só quem vê o Interno lê e completa, em nome próprio", async () => {
    const chave = `email:joao-${tag}@cliente.com.br`;
    await withPerson(app, lider, (db) => db.insert(missionParticipantNotes).values({ missionId, chave, cargo: "Coordenador de manutenção", updatedBy: lider }));
    const ler = (quem: string) => withPerson(app, quem, (db) => db.select().from(missionParticipantNotes).where(eq(missionParticipantNotes.missionId, missionId)));
    expect(await ler(lider)).toHaveLength(1);
    expect(await ler(fora)).toHaveLength(0);
    await falha(withPerson(app, fora, (db) => db.insert(missionParticipantNotes).values({ missionId, chave: `${chave}x`, updatedBy: fora })), /row-level security/);
    await falha(withPerson(app, lider, (db) => db.insert(missionParticipantNotes).values({ missionId, chave: `${chave}y`, updatedBy: fora })), /row-level security/);
    await owner.query("DELETE FROM mission_participant_notes WHERE mission_id = $1", [missionId]);
  });

  it("Prisma (0047): missão e empresas do cliente só para quem vê o Interno; feedback registrado é de cada um", async () => {
    await owner.query("DELETE FROM prisma_mission_links WHERE mission_id = $1", [missionId]);
    await owner.query("INSERT INTO prisma_companies (id, name, email_domains) VALUES ($1, 'Cliente IA', '{cliente-ia.com.br}') ON CONFLICT (id) DO NOTHING", [`emp-${tag}`]);
    await owner.query("INSERT INTO prisma_missions (id, company_ids) VALUES ($1, ARRAY[$2]) ON CONFLICT (id) DO NOTHING", [`pm-${tag}`, `emp-${tag}`]);
    await owner.query("INSERT INTO prisma_mission_links (prisma_mission_id, mission_id, method) VALUES ($1, $2, 'numero')", [`pm-${tag}`, missionId]);
    const da = (quem: string) => withPerson(app, quem, (db) => db.execute(sql`SELECT * FROM app.prisma_da_missao(${missionId}::uuid)`)).then((r) => r.rows);
    expect(await da(lider)).toEqual([{ prisma_mission_id: `pm-${tag}`, company_id: `emp-${tag}`, company_name: "Cliente IA", email_domains: ["cliente-ia.com.br"] }]);
    expect(await da(fora)).toEqual([]);
    const chave = randomUUID();
    await withPerson(app, lider, (db) => db.insert(prismaFeedbackLog).values({ chave, personId: lider, origem: "email", origemId: "m1" }));
    expect(await withPerson(app, fora, (db) => db.select().from(prismaFeedbackLog).where(eq(prismaFeedbackLog.chave, chave)))).toHaveLength(0);
    await falha(withPerson(app, fora, (db) => db.insert(prismaFeedbackLog).values({ chave: randomUUID(), personId: lider, origem: "email", origemId: "m2" })), /row-level security/);
    await owner.query("DELETE FROM prisma_feedback_log WHERE chave = $1", [chave]);
    await owner.query("DELETE FROM prisma_mission_links WHERE mission_id = $1", [missionId]);
  });

  it("quem ocupa a função endereçada pela IA vê o Interno; deixou a função, perde", async () => {
    const medidor = await pessoa("medidor", "operacao");
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO function_assignments (function_code, person_id, starts_on) VALUES ('medicao', $1, '2026-01-01') RETURNING id`,
      [medidor],
    );
    const ver = () => withPerson(app, medidor, (db) => db.select().from(aiQuestions).where(eq(aiQuestions.missionId, missionId)));
    expect(await ver()).toHaveLength(0);

    await owner.query(`INSERT INTO mission_function_access (mission_id, function_code, reason) VALUES ($1, 'medicao', 'medicao')`, [missionId]);
    expect(await ver()).toHaveLength(2);

    await owner.query(`UPDATE function_assignments SET ends_on = '2026-01-02' WHERE id = $1`, [rows[0]!.id]);
    expect(await ver()).toHaveLength(0);
  });

  it("a tela não lê nem concede acesso por função", async () => {
    await falha(
      withPerson(app, lider, (db) => db.execute(sql`SELECT * FROM mission_function_access`)),
      /permission denied/,
    );
    await falha(
      withPerson(app, lider, (db) => db.execute(sql`INSERT INTO mission_function_access (mission_id, function_code, reason) VALUES (${missionId}, 'qualidade', 'x')`)),
      /permission denied/,
    );
  });
});
