import { schema, type Db } from "@omni/db";
import {
  empresaPrismaSchema,
  missaoPrismaSchema,
  oportunidadePrismaSchema,
  type EmpresaPrisma,
  type EventoPrisma,
  type MissaoPrisma,
  type OportunidadePrisma,
  type PastaSharepoint,
  type PrismaClient,
} from "@omni/integrations/prisma";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";

/**
 * Prisma → Omni: empresas, oportunidades e missões com as referências das
 * pastas do SharePoint (contrato 1.66.0, migration 0020). O Prisma cria e
 * organiza as pastas; o Omni só copia os vínculos e liga a missão do Prisma à
 * do Omni por identificador (nunca pelo nome).
 *
 * - Carga completa (primeira vez e 1×/dia): guarda o `highWatermark` antes de
 *   ler as páginas e consome os eventos a partir dele; o que sumiu da lista é
 *   dado como excluído.
 * - Toda rodada: reconciliação por `updated_since` e o feed de eventos.
 * - `sharepointFolders` presente (até `[]`) substitui a lista; ausente (eventos
 *   antigos) mantém o que o Omni tem.
 * - Registro mais antigo nunca sobrescreve um mais novo (eventos repetidos ou
 *   atrasados em relação à lista).
 */

const FONTE = "prisma";
const RECURSO_EVENTOS = "eventos";
const RECURSO_CARGA = "carga";
const COMPLETA_A_CADA_MS = 24 * 3600 * 1000;
const SOBREPOSICAO_MS = 5 * 60 * 1000;

export type FontePrisma = Pick<PrismaClient, "listar" | "eventos">;
type Recurso = "companies" | "deals" | "missions";

export type ResultadoPrisma = {
  completa: boolean;
  gravados: number;
  ignorados: number;
  excluidos: number;
  eventos: number;
  pastas: number;
  vinculos: { criados: number; removidos: number };
};

const instante = (v: string | null | undefined) => (v ? new Date(v) : null);
/** Aplica só se o registro do Prisma é mais novo (ou igual) que o guardado. */
const naoMaisAntigo = (coluna: unknown) => sql`${coluna} IS NULL OR ${coluna} <= excluded.prisma_updated_at`;

/** Troca a lista de pastas do dono pela atual (ids estáveis: upsert + remoção do que saiu). */
async function substituirPastas(db: Db, ownerType: "deal" | "mission", ownerId: string, pastas: PastaSharepoint[], agora: Date): Promise<number> {
  const t = schema.sharepointFolderRefs;
  const unicas = [...new Map(pastas.map((p) => [p.folderId, p])).values()];
  await db
    .delete(t)
    .where(and(eq(t.ownerType, ownerType), eq(t.ownerId, ownerId), unicas.length ? notInArray(t.folderId, unicas.map((p) => p.folderId)) : undefined));
  for (const p of unicas) {
    const v = {
      // Sem biblioteca configurada não há o que abrir no Graph, mesmo que viesse um id.
      driveId: p.status === "ready" ? p.driveId : null,
      webUrl: p.webUrl,
      source: p.source,
      status: p.status === "ready" && !p.driveId ? ("configuration_required" as const) : p.status,
      syncedAt: agora,
    };
    await db
      .insert(t)
      .values({ ownerType, ownerId, folderId: p.folderId, ...v })
      .onConflictDoUpdate({ target: [t.ownerType, t.ownerId, t.folderId], set: v });
  }
  return unicas.length;
}

async function gravarEmpresa(db: Db, e: EmpresaPrisma, agora: Date): Promise<boolean> {
  const t = schema.prismaCompanies;
  const v = {
    name: e.name ?? null,
    taxId: e.taxId ?? null,
    emailDomains: (e.emailDomains ?? []).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
    deletedAt: instante(e.deletedAt),
    prismaUpdatedAt: instante(e.updatedAt),
    syncedAt: agora,
  };
  const r = await db
    .insert(t)
    .values({ id: e.id, ...v })
    .onConflictDoUpdate({ target: t.id, set: v, setWhere: naoMaisAntigo(t.prismaUpdatedAt) })
    .returning({ id: t.id });
  return r.length > 0;
}

async function gravarOportunidade(db: Db, d: OportunidadePrisma, agora: Date): Promise<{ aplicado: boolean; pastas: number }> {
  const t = schema.prismaDeals;
  const v = {
    code: d.code ?? null,
    proposalCode: d.proposalCode ?? null,
    title: d.title ?? null,
    status: d.status ?? null,
    companyId: d.companyId ?? null,
    prismaMissionId: d.missionId ?? null,
    deletedAt: instante(d.deletedAt),
    prismaUpdatedAt: instante(d.updatedAt),
    syncedAt: agora,
  };
  const r = await db
    .insert(t)
    .values({ id: d.id, ...v })
    .onConflictDoUpdate({ target: t.id, set: v, setWhere: naoMaisAntigo(t.prismaUpdatedAt) })
    .returning({ id: t.id });
  if (!r.length) return { aplicado: false, pastas: 0 };
  if (d.deletedAt) return { aplicado: true, pastas: await substituirPastas(db, "deal", d.id, [], agora) };
  return { aplicado: true, pastas: d.sharepointFolders ? await substituirPastas(db, "deal", d.id, d.sharepointFolders, agora) : 0 };
}

async function gravarMissao(db: Db, m: MissaoPrisma, agora: Date): Promise<{ aplicado: boolean; pastas: number }> {
  const t = schema.prismaMissions;
  const v = {
    number: m.number === null || m.number === undefined ? null : String(m.number),
    title: m.title ?? null,
    status: m.status ?? null,
    companyIds: m.companyIds ?? [],
    dealIds: m.dealIds ?? [],
    deletedAt: instante(m.deletedAt),
    prismaUpdatedAt: instante(m.updatedAt),
    syncedAt: agora,
  };
  const r = await db
    .insert(t)
    .values({ id: m.id, ...v })
    .onConflictDoUpdate({ target: t.id, set: v, setWhere: naoMaisAntigo(t.prismaUpdatedAt) })
    .returning({ id: t.id });
  if (!r.length) return { aplicado: false, pastas: 0 };
  if (m.deletedAt) return { aplicado: true, pastas: await substituirPastas(db, "mission", m.id, [], agora) };
  return { aplicado: true, pastas: m.sharepointFolders ? await substituirPastas(db, "mission", m.id, m.sharepointFolders, agora) : 0 };
}

/** Grava um registro de qualquer dos três recursos; devolve se aplicou e quantas pastas tem agora. */
async function gravar(db: Db, recurso: Recurso, dado: unknown, agora: Date): Promise<{ aplicado: boolean; pastas: number }> {
  if (recurso === "companies") return { aplicado: await gravarEmpresa(db, empresaPrismaSchema.parse(dado), agora), pastas: 0 };
  if (recurso === "deals") return gravarOportunidade(db, oportunidadePrismaSchema.parse(dado), agora);
  return gravarMissao(db, missaoPrismaSchema.parse(dado), agora);
}

const TABELA = { companies: schema.prismaCompanies, deals: schema.prismaDeals, missions: schema.prismaMissions } as const;
const DONO = { deals: "deal", missions: "mission" } as const;

/** Exclusão (tombstone do feed ou sumiço na carga completa): marca e tira as pastas. */
async function excluir(db: Db, recurso: Recurso, ids: string[], quando: Date): Promise<number> {
  if (!ids.length) return 0;
  const t = TABELA[recurso];
  const r = await db
    .update(t)
    .set({ deletedAt: quando, syncedAt: quando })
    .where(and(inArray(t.id, ids), isNull(t.deletedAt)))
    .returning({ id: t.id });
  if (recurso !== "companies") {
    await db
      .delete(schema.sharepointFolderRefs)
      .where(and(eq(schema.sharepointFolderRefs.ownerType, DONO[recurso]), inArray(schema.sharepointFolderRefs.ownerId, ids)));
  }
  return r.length;
}

/**
 * Liga missão do Prisma ↔ missão do Omni:
 * 1. pelo vínculo oficial do filtroAPP (`missions.prisma_mission_id`, método
 *    'filtroapp'), que tem prioridade e substitui um vínculo pelo número em conflito;
 * 2. sem ele, pelo número (o código da missão no filtroAPP vem do Prisma): só
 *    quando o número é único dos dois lados e o CNPJ das empresas do Prisma não
 *    contradiz o do filtroAPP (o Prisma tem duas numerações, filtrovali e fentecx).
 */
export async function ligarMissoes(db: Db): Promise<{ criados: number; removidos: number }> {
  const oficiais = sql`
    SELECT pm.id AS pmid, m.id AS mid
      FROM missions m JOIN prisma_missions pm ON pm.id = m.prisma_mission_id
     WHERE pm.deleted_at IS NULL`;
  const porNumero = sql`
    SELECT pm.id AS pmid, m.id AS mid
      FROM prisma_missions pm JOIN missions m ON m.code = pm.number
     WHERE pm.deleted_at IS NULL AND pm.number IS NOT NULL
       AND m.prisma_mission_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM missions o WHERE o.prisma_mission_id = pm.id)
       AND (SELECT count(*) FROM prisma_missions x WHERE x.number = pm.number AND x.deleted_at IS NULL) = 1
       AND (SELECT count(*) FROM missions y WHERE y.code = pm.number) = 1
       AND NOT (
         nullif(regexp_replace(coalesce(m.client_cnpj, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
         AND EXISTS (SELECT 1 FROM prisma_companies c WHERE c.id = ANY (pm.company_ids) AND c.tax_id IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM prisma_companies c WHERE c.id = ANY (pm.company_ids)
                          AND c.tax_id = regexp_replace(m.client_cnpj, '[^0-9]', '', 'g'))
       )`;
  // Sai o que não tem mais prova (cada método só pelo seu critério).
  const removidos = await db.execute(sql`
    DELETE FROM prisma_mission_links l
     WHERE (l.method = 'filtroapp' AND NOT EXISTS (SELECT 1 FROM (${oficiais}) c WHERE c.pmid = l.prisma_mission_id AND c.mid = l.mission_id))
        OR (l.method = 'numero' AND NOT EXISTS (SELECT 1 FROM (${porNumero}) c WHERE c.pmid = l.prisma_mission_id AND c.mid = l.mission_id)
            AND NOT EXISTS (SELECT 1 FROM (${oficiais}) c WHERE c.pmid = l.prisma_mission_id AND c.mid = l.mission_id))`);
  // O mesmo par provado pelo filtroAPP passa a ser 'filtroapp'.
  await db.execute(sql`
    UPDATE prisma_mission_links l SET method = 'filtroapp'
     WHERE l.method = 'numero' AND EXISTS (SELECT 1 FROM (${oficiais}) c WHERE c.pmid = l.prisma_mission_id AND c.mid = l.mission_id)`);
  const criados = await db.execute(sql`
    INSERT INTO prisma_mission_links (prisma_mission_id, mission_id, method)
    SELECT pmid, mid, 'filtroapp' FROM (${oficiais}) c
    UNION ALL
    SELECT pmid, mid, 'numero' FROM (${porNumero}) c
    ON CONFLICT DO NOTHING`);
  return { criados: criados.rowCount ?? 0, removidos: removidos.rowCount ?? 0 };
}

async function estado(db: Db, recurso: string) {
  const [e] = await db
    .select()
    .from(schema.syncState)
    .where(and(eq(schema.syncState.source, FONTE), eq(schema.syncState.resource, recurso)));
  return e;
}

async function salvar(db: Db, recurso: string, v: { cursor?: string | null; watermark?: Date | null; lastFullAt?: Date | null }, agora: Date) {
  await db
    .insert(schema.syncState)
    .values({ source: FONTE, resource: recurso, lastSuccessAt: agora, ...v })
    .onConflictDoUpdate({ target: [schema.syncState.source, schema.syncState.resource], set: { lastSuccessAt: agora, ...v } });
}

/** Aplica um evento do feed (repetido ou fora de ordem: idempotente e nunca volta no tempo). */
export async function aplicarEvento(db: Db, e: EventoPrisma, agora: Date): Promise<{ aplicado: boolean; pastas: number; excluido: boolean }> {
  if (!["companies", "deals", "missions"].includes(e.resource)) return { aplicado: false, pastas: 0, excluido: false };
  const recurso = e.resource as Recurso;
  const dado = e.data ?? {};
  if (e.type.endsWith(".deleted") || (typeof dado.deletedAt === "string" && dado.deletedAt)) {
    const n = await excluir(db, recurso, [e.recordId], instante((dado.deletedAt as string | undefined) ?? e.at) ?? agora);
    return { aplicado: n > 0, pastas: 0, excluido: true };
  }
  const r = await gravar(db, recurso, { id: e.recordId, ...dado, updatedAt: (dado.updatedAt as string | undefined) ?? e.at }, agora);
  return { ...r, excluido: false };
}

export async function syncPrismaComercial(db: Db, fonte: FontePrisma, opcoes: { forcarCompleta?: boolean; now?: () => Date } = {}): Promise<ResultadoPrisma> {
  const now = opcoes.now ?? (() => new Date());
  const inicio = now();
  const r: ResultadoPrisma = { completa: false, gravados: 0, ignorados: 0, excluidos: 0, eventos: 0, pastas: 0, vinculos: { criados: 0, removidos: 0 } };
  const [ev, carga] = [await estado(db, RECURSO_EVENTOS), await estado(db, RECURSO_CARGA)];
  r.completa = Boolean(opcoes.forcarCompleta) || !ev?.cursor || !carga?.lastFullAt || inicio.getTime() - carga.lastFullAt.getTime() >= COMPLETA_A_CADA_MS;

  let cursor = ev?.cursor ?? null;
  for (const recurso of ["companies", "deals", "missions"] as const) {
    const marca = await estado(db, recurso);
    const desde = !r.completa && marca?.watermark ? new Date(marca.watermark.getTime() - SOBREPOSICAO_MS) : undefined;
    const { itens, highWatermark } = await fonte.listar(recurso, desde ? { updatedSince: desde } : {});
    // Primeira carga: os eventos começam no marco lido antes das páginas.
    if (!cursor && highWatermark !== null) cursor = highWatermark;
    let watermark = marca?.watermark ?? null;
    for (const item of itens) {
      const g = await gravar(db, recurso, item, inicio);
      if (g.aplicado) r.gravados += 1;
      else r.ignorados += 1;
      r.pastas += g.pastas;
      const em = instante((item as { updatedAt?: string }).updatedAt);
      if (em && (!watermark || em > watermark)) watermark = em;
    }
    if (r.completa) {
      // O que não veio na lista completa sumiu do Prisma.
      const t = TABELA[recurso];
      const vistos = itens.map((x) => String((x as { id: unknown }).id));
      const sumiram = await db
        .select({ id: t.id })
        .from(t)
        .where(and(isNull(t.deletedAt), vistos.length ? notInArray(t.id, vistos) : undefined));
      r.excluidos += await excluir(db, recurso, sumiram.map((x) => x.id), inicio);
    }
    await salvar(db, recurso, { watermark: watermark ?? inicio, ...(r.completa ? { lastFullAt: inicio } : {}) }, now());
  }

  // Feed de eventos desde o cursor; o cursor é salvo a cada página (se falhar, relê só o resto).
  cursor ??= "0";
  for (let pagina = 0; pagina < 1000; pagina += 1) {
    const { itens, nextCursor } = await fonte.eventos(cursor);
    for (const e of itens) {
      const a = await aplicarEvento(db, e, inicio);
      r.eventos += 1;
      if (a.excluido && a.aplicado) r.excluidos += 1;
      r.pastas += a.pastas;
    }
    cursor = nextCursor;
    await salvar(db, RECURSO_EVENTOS, { cursor }, now());
    if (!itens.length) break;
  }

  r.vinculos = await ligarMissoes(db);
  if (r.completa) await salvar(db, RECURSO_CARGA, { lastFullAt: inicio }, now());
  return r;
}
