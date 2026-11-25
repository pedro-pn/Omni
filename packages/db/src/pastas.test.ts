import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/**
 * Pastas comerciais (migration 0020): quem vê qual pasta. Missão 9501 e os ids
 * `pt-*` do Prisma são deste teste.
 */

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

describe.skipIf(!available)("pastas comerciais: permissões", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let missao: string;
  const p: Record<string, string> = {};
  const tag = randomUUID().slice(0, 6);

  async function pessoa(nome: string, perfil: string) {
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [
      `${nome}-${tag}@filtrovali.com.br`,
      nome,
    ]);
    await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, perfil]);
    return rows[0]!.id;
  }
  const ref = async (ownerType: string, ownerId: string, folderId: string, source: string, status = "ready") =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO sharepoint_folder_refs (owner_type, owner_id, drive_id, folder_id, web_url, source, status)
         VALUES ($1, $2, $3, $4, 'https://exemplo.invalid/pasta', $5, $6) RETURNING id`,
        [ownerType, ownerId, status === "ready" ? "drive-pt" : null, folderId, source, status],
      )
    ).rows[0]!.id;
  const pastas = (quem: string, consulta: ReturnType<typeof sql>) =>
    withPerson(app, quem, (db) => db.execute<{ id: string; origem: string; rotulo: string }>(consulta)).then((r) => r.rows);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    await owner.query("DELETE FROM missions WHERE code = '9501'");
    await owner.query("DELETE FROM sharepoint_folder_refs WHERE owner_id LIKE 'pt-%'");
    await owner.query("DELETE FROM prisma_deals WHERE id LIKE 'pt-%'");
    await owner.query("DELETE FROM prisma_missions WHERE id LIKE 'pt-%'");
    missao = (
      await owner.query<{ id: string }>(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ('9501', 'pt-9501', 'Cliente P', true, now()) RETURNING id`,
      )
    ).rows[0]!.id;
    p.vendas = await pessoa("vendas", "vendas");
    p.lider = await pessoa("lider", "lider_projetos");
    p.gerente = await pessoa("gerente", "gerente");
    p.fora = await pessoa("fora", "operacao");
    await owner.query(`INSERT INTO mission_responsibles (mission_id, role, name, email, filtroapp_updated_at) VALUES ($1, 'LEADER', 'Líder', $2, now())`, [
      missao,
      `lider-${tag}@filtrovali.com.br`,
    ]);

    // Empresa pt-c1: a missão 9501 (ligada ao Omni), outra missão sem Omni e duas oportunidades. Empresa pt-c2: outra.
    await owner.query(`INSERT INTO prisma_missions (id, number, title, company_ids, deal_ids) VALUES
      ('pt-m1', '9501', 'Flushing', '{pt-c1}', '{pt-d1}'), ('pt-m2', '9502', 'Filtragem', '{pt-c1}', '{}'), ('pt-m3', '9503', 'Outra', '{pt-c2}', '{}')`);
    await owner.query(`INSERT INTO prisma_deals (id, code, title, company_id, prisma_mission_id) VALUES
      ('pt-d1', 'OP-1', 'Flushing L1', 'pt-c1', 'pt-m1'), ('pt-d3', 'OP-3', 'Nova proposta', 'pt-c1', NULL), ('pt-d2', 'OP-2', 'Cliente 2', 'pt-c2', NULL)`);
    await owner.query("INSERT INTO prisma_mission_links (prisma_mission_id, mission_id, method) VALUES ('pt-m1', $1, 'numero')", [missao]);
    ids.missao = await ref("mission", "pt-m1", "pt-f-missao", "mission");
    ids.opMissao = await ref("mission", "pt-m1", "pt-f-d1", "opportunity");
    ids.d1 = await ref("deal", "pt-d1", "pt-f-d1", "opportunity");
    ids.d3 = await ref("deal", "pt-d3", "pt-f-d3", "opportunity");
    ids.m2 = await ref("mission", "pt-m2", "pt-f-m2", "mission");
    ids.d2 = await ref("deal", "pt-d2", "pt-f-d2", "opportunity");
    ids.m3 = await ref("mission", "pt-m3", "pt-f-m3", "mission", "configuration_required");
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
  });

  it("a tela não lê as tabelas do Prisma diretamente", async () => {
    for (const t of ["sharepoint_folder_refs", "prisma_deals", "prisma_missions", "prisma_companies", "prisma_mission_links"]) {
      await expect(pastas(p.gerente!, sql`SELECT 1 FROM ${sql.raw(t)}`)).rejects.toThrow();
    }
  });

  it("na missão: comercial vê a pasta da missão e a da oportunidade; quem vê o Interno, só a da missão; quem não vê, nada", async () => {
    const q = sql`SELECT * FROM app.pastas_da_missao(${missao}::uuid)`;
    expect((await pastas(p.vendas!, q)).map((x) => x.rotulo)).toEqual(["Missão 9501", "Oportunidade OP-1 · Flushing L1"]);
    expect((await pastas(p.lider!, q)).map((x) => x.id)).toEqual([ids.missao]);
    expect(await pastas(p.fora!, q)).toEqual([]);
  });

  it("no cliente: as outras oportunidades e missões das mesmas empresas, sem repetir e sem outra empresa", async () => {
    const q = sql`SELECT * FROM app.pastas_do_cliente(${missao}::uuid)`;
    const doVendas = (await pastas(p.vendas!, q)).map((x) => x.id).sort();
    expect(doVendas).toEqual([ids.d3, ids.m2].sort()); // pt-f-d1 já está na missão; pt-c2 fica de fora
    // Gestão vê a pasta de outra missão do cliente, mas não as propostas de oportunidade… só se for comercial (gerente é).
    expect((await pastas(p.gerente!, q)).map((x) => x.id).sort()).toEqual([ids.d3, ids.m2].sort());
    // Quem só vê o Interno desta missão não vê as pastas de outras missões nem das oportunidades.
    expect(await pastas(p.lider!, q)).toEqual([]);
  });

  it("para abrir no Graph: só com permissão, e oportunidade excluída some", async () => {
    const abrir = (quem: string, id: string) => pastas(quem, sql`SELECT * FROM app.pasta_para_leitura(${id}::uuid)`);
    expect(await abrir(p.lider!, ids.d1!)).toEqual([]);
    expect((await abrir(p.lider!, ids.missao!))[0]).toMatchObject({ drive_id: "drive-pt", folder_id: "pt-f-missao" });
    expect((await abrir(p.vendas!, ids.d1!))[0]).toMatchObject({ folder_id: "pt-f-d1" });
    await owner.query("UPDATE prisma_deals SET deleted_at = now() WHERE id = 'pt-d3'");
    expect(await abrir(p.vendas!, ids.d3!)).toEqual([]);
    await owner.query("UPDATE prisma_deals SET deleted_at = NULL WHERE id = 'pt-d3'");
  });

  it("sem biblioteca configurada a referência existe, mas sem drive", async () => {
    const [m3] = await pastas(p.vendas!, sql`SELECT * FROM app.pasta_para_leitura(${ids.m3}::uuid)`);
    expect(m3).toMatchObject({ drive_id: null, status: "configuration_required" });
    await expect(owner.query("INSERT INTO sharepoint_folder_refs (owner_type, owner_id, folder_id, source, status) VALUES ('deal', 'pt-x', 'pt-y', 'opportunity', 'ready')")).rejects.toThrow();
  });
});
