import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Revisão semanal (migrations 0017 e 0018): Qualidade, valores, contagens e Gestão do filtroAPP. Missão 9401 é deste teste. */

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

describe.skipIf(!available)("revisão semanal: permissões", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let missao: string;
  let gerente: string;
  let lider: string;
  let fora: string;
  const tag = randomUUID().slice(0, 6);

  async function pessoa(nome: string, perfil: string) {
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [
      `${nome}-${tag}@filtrovali.com.br`,
      nome,
    ]);
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, perfil]);
    return rows[0]!.id;
  }
  const ler = (quem: string, consulta: ReturnType<typeof sql>) => withPerson(app, quem, (db) => db.execute<Record<string, unknown>>(consulta)).then((r) => r.rows);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    await owner.query("DELETE FROM missions WHERE code = '9401'");
    missao = (
      await owner.query<{ id: string }>(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ('9401', 'rv-9401', 'Cliente R', true, now()) RETURNING id`,
      )
    ).rows[0]!.id;
    gerente = await pessoa("gerente", "gerente");
    lider = await pessoa("lider", "lider_projetos");
    fora = await pessoa("fora", "operacao");
    await owner.query(
      `INSERT INTO mission_responsibles (mission_id, role, name, email, filtroapp_updated_at) VALUES ($1, 'LEADER', 'Líder', $2, now())`,
      [missao, `lider-${tag}@filtrovali.com.br`],
    );
    await owner.query(
      `INSERT INTO mission_quality_records (id, mission_id, number, type, status, filtroapp_updated_at) VALUES ('q-9401', $1, 'D-1/26', 'DESVIO', 'ABERTO', now())`,
      [missao],
    );
    await owner.query(
      `INSERT INTO mission_pending (mission_id, a_pagar_qtd, a_pagar_valor, a_receber_qtd, a_receber_valor, filtroapp_updated_at) VALUES ($1, 1, 250.50, 0, 0, now())`,
      [missao],
    );
    await owner.query(
      `INSERT INTO mission_allocations (id, mission_id, collaborator_id, funcao, mobilizacao, filtroapp_updated_at) VALUES ('al-9401', $1, 'col-1', 'Técnico', '2026-11-02', now())`,
      [missao],
    );
    await owner.query(
      `INSERT INTO mission_timesheet_weeks (mission_id, week_start, minutos_normais, minutos_extra_70, minutos_extra_100, minutos_noturnos, pessoas, filtroapp_updated_at)
       VALUES ($1, '2026-10-26', 4800, 60, 0, 0, 2, now())`,
      [missao],
    );
    await owner.query(
      `INSERT INTO mission_conditions (mission_id, permanencia_prevista_dias, diaria_stand_by, filtroapp_updated_at) VALUES ($1, 30, 2000, now())`,
      [missao],
    );
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("Qualidade: gerente e quem vê o Interno; quem não vê, não", async () => {
    const q = sql`SELECT id FROM mission_quality_records WHERE mission_id = ${missao}`;
    expect(await ler(gerente, q)).toHaveLength(1);
    expect(await ler(lider, q)).toHaveLength(1);
    expect(await ler(fora, q)).toHaveLength(0);
  });

  it("valores em reais e contagens: só gerente e diretoria", async () => {
    const fin = sql`SELECT a_pagar FROM app.financeiro_missoes() WHERE mission_id = ${missao}`;
    expect((await ler(gerente, fin))[0]?.a_pagar).toBe("250.50");
    expect(await ler(lider, fin)).toHaveLength(0);
    const cont = sql`SELECT * FROM app.contagens_revisao(current_date) WHERE mission_id = ${missao}`;
    expect(await ler(gerente, cont)).toHaveLength(1);
    expect(await ler(fora, cont)).toHaveLength(0);
  });

  it("Gestão: alocações e ponto para gestão e quem vê o Interno; diária só pela função de custos", async () => {
    for (const tabela of ["mission_allocations", "mission_timesheet_weeks"]) {
      const q = sql`SELECT 1 FROM ${sql.raw(tabela)} WHERE mission_id = ${missao}`;
      expect(await ler(gerente, q)).toHaveLength(1);
      expect(await ler(lider, q)).toHaveLength(1);
      expect(await ler(fora, q)).toHaveLength(0);
    }
    // Condições: quem vê a missão (0045); fora dela, não.
    expect(await ler(lider, sql`SELECT permanencia_prevista_dias FROM mission_conditions WHERE mission_id = ${missao}`)).toHaveLength(1);
    expect(await ler(fora, sql`SELECT permanencia_prevista_dias FROM mission_conditions WHERE mission_id = ${missao}`)).toHaveLength(0);
    await expect(ler(gerente, sql`SELECT diaria_stand_by FROM mission_conditions`)).rejects.toThrow();
    const diaria = sql`SELECT diaria_stand_by FROM app.custos_missoes() WHERE mission_id = ${missao}`;
    expect((await ler(gerente, diaria))[0]?.diaria_stand_by).toBe("2000.00");
    expect(await ler(lider, diaria)).toHaveLength(0);
  });
});
