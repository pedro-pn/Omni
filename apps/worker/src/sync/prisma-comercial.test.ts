import { createPool, createWorkerDb, migrate, schema } from "@omni/db";
import type { EventoPrisma, PrismaRecurso } from "@omni/integrations/prisma";
import { eq, inArray, like, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { aplicarEvento, ligarMissoes, syncPrismaComercial, type FontePrisma } from "./prisma-comercial.ts";

/** Prisma → Omni (pastas do SharePoint) no banco real (omni_test), com fixtures sintéticas. Ids `pc-*` e missões 74xx são deste arquivo. */

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

const pasta = (folderId: string, source: "opportunity" | "mission" = "opportunity", extra: Record<string, unknown> = {}) => ({
  driveId: "drive-sintetico",
  folderId,
  webUrl: `https://exemplo.invalid/${folderId}`,
  source,
  status: "ready",
  ...extra,
});
const T0 = "2026-11-03T12:00:00.000Z";
const T1 = "2026-11-03T13:00:00.000Z";

type Dados = Record<"companies" | "deals" | "missions", Record<string, unknown>[]>;
function fonte(dados: Dados, eventos: EventoPrisma[], chamadas: string[] = []): FontePrisma {
  return {
    listar: async (recurso: PrismaRecurso, filtros: { updatedSince?: Date } = {}) => {
      chamadas.push(`${recurso}${filtros.updatedSince ? "+desde" : ""}`);
      return { itens: dados[recurso as keyof Dados] ?? [], highWatermark: "10" };
    },
    eventos: async (cursor: string) => {
      chamadas.push(`eventos@${cursor}`);
      const novos = eventos.filter((e) => Number(e.cursor) > Number(cursor)).slice(0, 2);
      return { itens: novos, nextCursor: novos.at(-1)?.cursor ?? cursor, highWatermark: "99" };
    },
  };
}
const evento = (cursor: number, type: string, recordId: string, data: Record<string, unknown> | null): EventoPrisma => ({
  id: cursor,
  cursor: String(cursor),
  type,
  resource: type.split(".")[0]!,
  recordId,
  at: T1,
  data,
});

describe.skipIf(!available)("Prisma → Omni: pastas do SharePoint", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let missao: string;
  const db = () => createWorkerDb(worker);
  const refs = async (ownerId: string) =>
    (await db().select().from(schema.sharepointFolderRefs).where(eq(schema.sharepointFolderRefs.ownerId, ownerId))).sort((a, b) =>
      a.folderId.localeCompare(b.folderId),
    );

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
  });

  beforeEach(async () => {
    await owner.query("DELETE FROM missions WHERE code IN ('7401', '7402', '7403')");
    await owner.query("DELETE FROM sharepoint_folder_refs WHERE owner_id LIKE 'pc-%'");
    for (const t of ["prisma_deals", "prisma_missions", "prisma_companies"]) await owner.query(`DELETE FROM ${t} WHERE id LIKE 'pc-%'`);
    await owner.query("DELETE FROM sync_state WHERE source = 'prisma'");
    missao = (
      await owner.query<{ id: string }>(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, client_cnpj, is_active, filtroapp_updated_at)
         VALUES ('7401', 'pc-7401', 'Cliente Sintético', '12345678000190', true, now()) RETURNING id`,
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await owner?.query("DELETE FROM sync_state WHERE source = 'prisma'");
    await Promise.all([owner?.end(), worker?.end()]);
  });

  const base = (): Dados => ({
    companies: [{ id: "pc-c1", name: "Cliente Sintético", taxId: "12345678000190", updatedAt: T0, deletedAt: null }],
    deals: [
      { id: "pc-d1", code: "OP-1", title: "Flushing", companyId: "pc-c1", missionId: "pc-m1", updatedAt: T0, deletedAt: null, sharepointFolders: [pasta("pc-f-d1")] },
      { id: "pc-d2", code: "OP-2", title: "Nova", companyId: "pc-c1", missionId: null, updatedAt: T0, deletedAt: null, sharepointFolders: [pasta("pc-f-d2")] },
    ],
    missions: [
      {
        id: "pc-m1",
        number: 7401,
        title: "Flushing",
        companyIds: ["pc-c1"],
        dealIds: ["pc-d1"],
        updatedAt: T0,
        deletedAt: null,
        sharepointFolders: [pasta("pc-f-m1", "mission"), pasta("pc-f-d1")],
      },
    ],
  });

  it("carga inicial: grava, liga a missão pelo número e consome os eventos desde o highWatermark", async () => {
    const chamadas: string[] = [];
    const eventos = [evento(11, "deals.updated", "pc-d2", { id: "pc-d2", title: "Nova (rev. 2)", companyId: "pc-c1", updatedAt: T1, sharepointFolders: [pasta("pc-f-d2")] })];
    const r = await syncPrismaComercial(db(), fonte(base(), eventos, chamadas), { now: () => new Date(T1) });
    expect(r).toMatchObject({ completa: true, gravados: 4, eventos: 1, vinculos: { criados: 1 } });
    expect(chamadas).toEqual(["companies", "deals", "missions", "eventos@10", "eventos@11"]);
    expect((await refs("pc-m1")).map((x) => [x.folderId, x.source])).toEqual([
      ["pc-f-d1", "opportunity"],
      ["pc-f-m1", "mission"],
    ]);
    const [link] = await db().select().from(schema.prismaMissionLinks).where(eq(schema.prismaMissionLinks.missionId, missao));
    expect(link).toMatchObject({ prismaMissionId: "pc-m1", method: "numero" });
    const [d2] = await db().select().from(schema.prismaDeals).where(eq(schema.prismaDeals.id, "pc-d2"));
    expect(d2?.title).toBe("Nova (rev. 2)");
    const [ev] = await db().select().from(schema.syncState).where(sql`source = 'prisma' AND resource = 'eventos'`);
    expect(ev?.cursor).toBe("11");

    // Rodada seguinte: incremental por updated_since, eventos do cursor salvo.
    chamadas.length = 0;
    const r2 = await syncPrismaComercial(db(), fonte(base(), eventos, chamadas), { now: () => new Date(T1) });
    expect(r2.completa).toBe(false);
    expect(chamadas).toEqual(["companies+desde", "deals+desde", "missions+desde", "eventos@11"]);
  });

  it("eventos: [] limpa, campo ausente mantém, repetido ou atrasado não volta no tempo, exclusão tira as pastas", async () => {
    await syncPrismaComercial(db(), fonte(base(), []), { now: () => new Date(T1) });
    const idAntes = (await refs("pc-d1"))[0]!.id;
    const agora = new Date(T1);

    // Evento antigo sem sharepointFolders: não apaga.
    await aplicarEvento(db(), evento(20, "deals.updated", "pc-d1", { id: "pc-d1", title: "Flushing", companyId: "pc-c1", updatedAt: T1 }), agora);
    expect((await refs("pc-d1")).map((x) => x.id)).toEqual([idAntes]);

    // Mesma pasta em nova lista: id estável.
    await aplicarEvento(db(), evento(21, "deals.folder_changed", "pc-d1", { id: "pc-d1", updatedAt: T1, sharepointFolders: [pasta("pc-f-d1"), pasta("pc-f-d1b")] }), agora);
    expect((await refs("pc-d1")).map((x) => x.folderId)).toEqual(["pc-f-d1", "pc-f-d1b"]);
    expect((await refs("pc-d1"))[0]!.id).toBe(idAntes);

    // Lista vazia substitui e limpa.
    await aplicarEvento(db(), evento(22, "deals.folder_changed", "pc-d1", { id: "pc-d1", updatedAt: "2026-11-03T14:00:00.000Z", sharepointFolders: [] }), agora);
    expect(await refs("pc-d1")).toEqual([]);

    // Repetição de um evento mais antigo: ignorado (não recoloca a pasta).
    const velho = await aplicarEvento(db(), evento(21, "deals.folder_changed", "pc-d1", { id: "pc-d1", updatedAt: T1, sharepointFolders: [pasta("pc-f-d1")] }), agora);
    expect(velho.aplicado).toBe(false);
    expect(await refs("pc-d1")).toEqual([]);

    // Sem biblioteca configurada: fica como configuration_required, sem drive.
    await aplicarEvento(db(), evento(23, "deals.folder_changed", "pc-d2", { id: "pc-d2", updatedAt: "2026-11-03T15:00:00.000Z", sharepointFolders: [pasta("pc-f-d2", "opportunity", { driveId: null, status: "configuration_required" })] }), agora);
    expect((await refs("pc-d2"))[0]).toMatchObject({ driveId: null, status: "configuration_required" });

    // Exclusão (tombstone): marca e tira as pastas.
    await aplicarEvento(db(), evento(24, "missions.deleted", "pc-m1", { id: "pc-m1", deletedAt: "2026-11-03T16:00:00.000Z" }), agora);
    expect(await refs("pc-m1")).toEqual([]);
    const [m1] = await db().select().from(schema.prismaMissions).where(eq(schema.prismaMissions.id, "pc-m1"));
    expect(m1?.deletedAt).not.toBeNull();
    expect((await ligarMissoes(db())).removidos).toBe(1);
  });

  it("vínculo só com prova: número repetido ou CNPJ em conflito não liga", async () => {
    const dados = base();
    dados.missions.push({ id: "pc-m9", number: "7401", title: "Outra numeração", companyIds: [], dealIds: [], updatedAt: T0, deletedAt: null, sharepointFolders: [] });
    await syncPrismaComercial(db(), fonte(dados, []), { now: () => new Date(T1) });
    expect(await db().select().from(schema.prismaMissionLinks).where(eq(schema.prismaMissionLinks.missionId, missao))).toEqual([]);

    await owner.query("DELETE FROM prisma_missions WHERE id = 'pc-m9'");
    await owner.query("UPDATE prisma_companies SET tax_id = '99999999000199' WHERE id = 'pc-c1'");
    expect((await ligarMissoes(db())).criados).toBe(0);
    await owner.query("UPDATE prisma_companies SET tax_id = '12345678000190' WHERE id = 'pc-c1'");
    expect((await ligarMissoes(db())).criados).toBe(1);
  });

  it("carga completa dá como excluído o que sumiu do Prisma", async () => {
    await syncPrismaComercial(db(), fonte(base(), []), { now: () => new Date(T1) });
    const dados = base();
    dados.deals = dados.deals.filter((d) => d.id !== "pc-d2");
    const r = await syncPrismaComercial(db(), fonte(dados, []), { forcarCompleta: true, now: () => new Date(T1) });
    expect(r.excluidos).toBe(1);
    expect(await refs("pc-d2")).toEqual([]);
    const vivos = await db().select({ id: schema.prismaDeals.id }).from(schema.prismaDeals).where(inArray(schema.prismaDeals.id, ["pc-d1", "pc-d2"]));
    expect(vivos).toHaveLength(2); // continua guardada, marcada como excluída
    const [d2] = await db().select().from(schema.prismaDeals).where(like(schema.prismaDeals.id, "pc-d2"));
    expect(d2?.deletedAt).not.toBeNull();
  });

  it("vínculo oficial do filtroAPP tem prioridade sobre o número e troca o vínculo em conflito", async () => {
    const dados = base();
    dados.missions.push({ id: "pc-m7", number: "7499", title: "Oficial", companyIds: ["pc-c1"], dealIds: [], updatedAt: T0, deletedAt: null, sharepointFolders: [] });
    await syncPrismaComercial(db(), fonte(dados, []), { now: () => new Date(T1) });
    const link = async () => (await db().select().from(schema.prismaMissionLinks).where(eq(schema.prismaMissionLinks.missionId, missao)))[0];
    expect(await link()).toMatchObject({ prismaMissionId: "pc-m1", method: "numero" });

    // O filtroAPP diz que a missão 7401 é a pc-m7 (outra numeração): troca.
    await owner.query("UPDATE missions SET prisma_mission_id = 'pc-m7' WHERE id = $1", [missao]);
    await ligarMissoes(db());
    expect(await link()).toMatchObject({ prismaMissionId: "pc-m7", method: "filtroapp" });

    // Mesmo par que o número já provava: vira 'filtroapp'.
    await owner.query("UPDATE missions SET prisma_mission_id = 'pc-m1' WHERE id = $1", [missao]);
    await ligarMissoes(db());
    expect(await link()).toMatchObject({ prismaMissionId: "pc-m1", method: "filtroapp" });

    // Sem o vínculo oficial, volta ao número.
    await owner.query("UPDATE missions SET prisma_mission_id = NULL WHERE id = $1", [missao]);
    await ligarMissoes(db());
    expect(await link()).toMatchObject({ prismaMissionId: "pc-m1", method: "numero" });
  });
});
