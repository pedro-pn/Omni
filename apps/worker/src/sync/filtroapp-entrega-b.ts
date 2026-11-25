import { schema, type Db } from "@omni/db";
import type { BusinessCalendar } from "@omni/core";
import type {
  Alocacao,
  Condicoes,
  Descarga,
  FiltroAppClient,
  Medicao,
  Nota,
  Pendencia,
  RegistroQualidade,
  Romaneio,
} from "@omni/integrations/filtroapp";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

/**
 * Entrega B do filtroAPP (spec 034): medição, notas, romaneios, pendências no
 * Omie e descargas, copiadas para o Omni (migration 0016) para a IA perguntar
 * só o que o filtroAPP não sabe; e os registros da Qualidade (0017) para a
 * revisão semanal; e, da Gestão (B6, 0018), condições da proposta e
 * alocações do Efetivo. Cada recurso tem a própria marca d'água
 * (`sync_state`): incremental por `updatedSince` com 5 min de sobreposição e
 * completo uma vez por dia — o completo também remove o que sumiu do filtroAPP
 * (ex.: nota cancelada ou desligada do projeto). Projeto que o Omni ainda não
 * conhece é ignorado (entra quando a missão for sincronizada).
 */

const FONTE = "filtroapp";
const COMPLETA_A_CADA_MS = 24 * 3600 * 1000;
const SOBREPOSICAO_MS = 5 * 60 * 1000;

export type FonteEntregaB = Pick<
  FiltroAppClient,
  | "listMedicoes"
  | "listNotas"
  | "listRomaneios"
  | "listPendencias"
  | "listDescargas"
  | "listRegistrosQualidade"
  | "listCondicoes"
  | "listAlocacoes"
>;
export type ResultadoRecurso = { completa: boolean; gravados: number; ignorados: number; removidos: number };

const instante = (v: string | null | undefined) => (v ? new Date(v) : null);
const numero = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

type Recurso<T> = {
  nome: string;
  listar: (f: FonteEntregaB, p: { updatedSince?: Date }) => Promise<T[]>;
  projeto: (x: T) => string;
  atualizado: (x: T) => string;
  gravar: (db: Db, x: T, missionId: string, agora: Date) => Promise<void>;
  /** Na completa, apaga o que não veio (só das missões conhecidas). */
  limpar: (db: Db, vistos: T[], missoes: string[]) => Promise<number>;
};

const MEDICOES: Recurso<Medicao> = {
  nome: "medicoes",
  listar: (f, p) => f.listMedicoes(p),
  projeto: (m) => m.projectId,
  atualizado: (m) => m.updatedAt,
  async gravar(db, m, missionId, agora) {
    const v = {
      situacao: m.situacao,
      preparedAt: instante(m.preparedAt),
      sentAt: instante(m.sentAt),
      approvedAt: instante(m.approvedAt),
      saldoPendente: m.saldoPendente,
      executedAmount: numero(m.executedAmount),
      measuredAmount: numero(m.measuredAmount),
      approvedAmount: numero(m.approvedAmount),
      currency: m.currency ?? null,
      filtroappUpdatedAt: new Date(m.updatedAt),
      syncedAt: agora,
    };
    await db.insert(schema.missionMeasurements).values({ missionId, ...v }).onConflictDoUpdate({ target: schema.missionMeasurements.missionId, set: v });
  },
  async limpar(db, vistos, missoes) {
    const manter = vistos.map((m) => m.projectId);
    const r = await db
      .delete(schema.missionMeasurements)
      .where(
        and(
          inArray(schema.missionMeasurements.missionId, missoes),
          manter.length ? notInArray(schema.missionMeasurements.missionId, await missoesDe(db, manter)) : undefined,
        ),
      )
      .returning({ id: schema.missionMeasurements.missionId });
    return r.length;
  },
};

const NOTAS: Recurso<Nota> = {
  nome: "notas",
  listar: (f, p) => f.listNotas(p),
  projeto: (n) => n.projectId,
  atualizado: (n) => n.updatedAt,
  async gravar(db, n, missionId, agora) {
    const v = {
      missionId,
      tipo: n.tipo,
      numero: n.numero,
      serie: n.serie,
      dataEmissao: new Date(n.dataEmissao),
      valor: numero(n.valor),
      situacaoRecebimento: n.situacaoRecebimento,
      filtroappUpdatedAt: new Date(n.updatedAt),
      syncedAt: agora,
    };
    await db.insert(schema.missionInvoices).values({ id: n.id, ...v }).onConflictDoUpdate({ target: schema.missionInvoices.id, set: v });
  },
  async limpar(db, vistos, missoes) {
    const ids = vistos.map((n) => n.id);
    const r = await db
      .delete(schema.missionInvoices)
      .where(and(inArray(schema.missionInvoices.missionId, missoes), ids.length ? notInArray(schema.missionInvoices.id, ids) : undefined))
      .returning({ id: schema.missionInvoices.id });
    return r.length;
  },
};

const ROMANEIOS: Recurso<Romaneio> = {
  nome: "romaneios",
  listar: (f, p) => f.listRomaneios(p),
  projeto: (r) => r.projectId,
  atualizado: (r) => r.updatedAt,
  async gravar(db, r, missionId, agora) {
    const v = {
      missionId,
      tipo: r.tipo,
      data: new Date(r.data),
      emitidoEm: instante(r.emitidoEm),
      quantidadeItens: r.quantidadeItens,
      pesoCarga: numero(r.pesoCarga),
      unidadePeso: r.unidadePeso,
      filtroappUpdatedAt: new Date(r.updatedAt),
      syncedAt: agora,
    };
    await db.insert(schema.missionRomaneios).values({ id: r.id, ...v }).onConflictDoUpdate({ target: schema.missionRomaneios.id, set: v });
  },
  async limpar(db, vistos, missoes) {
    const ids = vistos.map((r) => r.id);
    const r = await db
      .delete(schema.missionRomaneios)
      .where(and(inArray(schema.missionRomaneios.missionId, missoes), ids.length ? notInArray(schema.missionRomaneios.id, ids) : undefined))
      .returning({ id: schema.missionRomaneios.id });
    return r.length;
  },
};

const PENDENCIAS: Recurso<Pendencia> = {
  nome: "pendencias",
  listar: (f, p) => f.listPendencias(p),
  projeto: (p) => p.projectId,
  atualizado: (p) => p.atualizadoEm,
  async gravar(db, p, missionId, agora) {
    const v = {
      aPagarQtd: p.aPagar.quantidade,
      aPagarValor: numero(p.aPagar.valorEmAberto),
      aPagarVencimento: instante(p.aPagar.proximoVencimento),
      aReceberQtd: p.aReceber.quantidade,
      aReceberValor: numero(p.aReceber.valorEmAberto),
      aReceberVencimento: instante(p.aReceber.proximoVencimento),
      filtroappUpdatedAt: new Date(p.atualizadoEm),
      syncedAt: agora,
    };
    await db.insert(schema.missionPending).values({ missionId, ...v }).onConflictDoUpdate({ target: schema.missionPending.missionId, set: v });
  },
  async limpar(db, vistos, missoes) {
    const manter = await missoesDe(
      db,
      vistos.map((p) => p.projectId),
    );
    const r = await db
      .delete(schema.missionPending)
      .where(and(inArray(schema.missionPending.missionId, missoes), manter.length ? notInArray(schema.missionPending.missionId, manter) : undefined))
      .returning({ id: schema.missionPending.missionId });
    return r.length;
  },
};

const DESCARGAS: Recurso<Descarga> = {
  nome: "descargas",
  listar: (f, p) => f.listDescargas(p),
  projeto: (d) => d.projectId,
  atualizado: (d) => d.updatedAt,
  async gravar(db, d, missionId, agora) {
    const v = {
      romaneioId: d.romaneioId,
      missionId,
      tipo: d.tipo,
      confirmadaEm: new Date(d.confirmadaEm),
      confirmadaPorEmail: d.confirmadaPorEmail.toLowerCase(),
      cte: d.cte,
      filtroappUpdatedAt: new Date(d.updatedAt),
      syncedAt: agora,
    };
    await db.insert(schema.missionUnloadings).values({ id: d.id, ...v }).onConflictDoUpdate({ target: schema.missionUnloadings.id, set: v });
  },
  async limpar(db, vistos, missoes) {
    const ids = vistos.map((d) => d.id);
    const r = await db
      .delete(schema.missionUnloadings)
      .where(and(inArray(schema.missionUnloadings.missionId, missoes), ids.length ? notInArray(schema.missionUnloadings.id, ids) : undefined))
      .returning({ id: schema.missionUnloadings.id });
    return r.length;
  },
};

const QUALIDADE: Recurso<RegistroQualidade> = {
  nome: "qualidade",
  listar: (f, p) => f.listRegistrosQualidade(p),
  // Registro sem projeto (ex.: lição geral) não é de nenhuma missão: fica de fora.
  projeto: (q) => q.project?.id ?? "",
  atualizado: (q) => q.updatedAt,
  async gravar(db, q, missionId, agora) {
    const v = {
      missionId,
      number: q.number,
      type: q.type,
      status: q.status,
      impact: q.impact,
      eventDate: q.eventDate,
      nature: q.nature?.name ?? null,
      actionDeadline: q.actionDeadline ? q.actionDeadline.slice(0, 10) : null,
      recurrent: q.recurrence?.recurrent ?? null,
      deletedAt: instante(q.deletedAt),
      filtroappUpdatedAt: new Date(q.updatedAt),
      syncedAt: agora,
    };
    await db.insert(schema.missionQualityRecords).values({ id: q.id, ...v }).onConflictDoUpdate({ target: schema.missionQualityRecords.id, set: v });
  },
  async limpar(db, vistos, missoes) {
    const ids = vistos.map((q) => q.id);
    const r = await db
      .delete(schema.missionQualityRecords)
      .where(and(inArray(schema.missionQualityRecords.missionId, missoes), ids.length ? notInArray(schema.missionQualityRecords.id, ids) : undefined))
      .returning({ id: schema.missionQualityRecords.id });
    return r.length;
  },
};

const CONDICOES: Recurso<Condicoes> = {
  nome: "condicoes",
  listar: (f, p) => f.listCondicoes(p),
  projeto: (c) => c.projectId,
  atualizado: (c) => c.updatedAt,
  async gravar(db, c, missionId, agora) {
    const v = {
      permanenciaPrevistaDias: c.permanenciaPrevistaDias,
      // Sem o escopo dos valores a diária não vem (undefined): fica vazia.
      diariaStandBy: numero(c.diariaStandByEquipamento),
      filtroappUpdatedAt: new Date(c.updatedAt),
      syncedAt: agora,
    };
    await db.insert(schema.missionConditions).values({ missionId, ...v }).onConflictDoUpdate({ target: schema.missionConditions.missionId, set: v });
  },
  async limpar(db, vistos, missoes) {
    const manter = await missoesDe(
      db,
      vistos.map((c) => c.projectId),
    );
    const r = await db
      .delete(schema.missionConditions)
      .where(and(inArray(schema.missionConditions.missionId, missoes), manter.length ? notInArray(schema.missionConditions.missionId, manter) : undefined))
      .returning({ id: schema.missionConditions.missionId });
    return r.length;
  },
};

const ALOCACOES: Recurso<Alocacao> = {
  nome: "alocacoes",
  listar: (f, p) => f.listAlocacoes(p),
  projeto: (a) => a.projectId,
  atualizado: (a) => a.updatedAt,
  async gravar(db, a, missionId, agora) {
    const v = {
      missionId,
      collaboratorId: a.collaboratorId,
      funcao: a.funcao,
      mobilizacao: a.mobilizacao,
      desmobilizacao: a.desmobilizacao,
      deletedAt: instante(a.deletedAt),
      filtroappUpdatedAt: new Date(a.updatedAt),
      syncedAt: agora,
    };
    await db.insert(schema.missionAllocations).values({ id: a.id, ...v }).onConflictDoUpdate({ target: schema.missionAllocations.id, set: v });
  },
  async limpar(db, vistos, missoes) {
    const ids = vistos.map((a) => a.id);
    const r = await db
      .delete(schema.missionAllocations)
      .where(and(inArray(schema.missionAllocations.missionId, missoes), ids.length ? notInArray(schema.missionAllocations.id, ids) : undefined))
      .returning({ id: schema.missionAllocations.id });
    return r.length;
  },
};

async function missoesDe(db: Db, projetos: string[]): Promise<string[]> {
  if (!projetos.length) return [];
  const r = await db
    .select({ id: schema.missions.id })
    .from(schema.missions)
    .where(inArray(schema.missions.filtroappProjectId, projetos));
  return r.map((x) => x.id);
}

async function sincronizar<T>(
  db: Db,
  fonte: FonteEntregaB,
  recurso: Recurso<T>,
  opcoes: { forcarCompleta?: boolean; now?: () => Date },
): Promise<ResultadoRecurso> {
  const now = opcoes.now ?? (() => new Date());
  const inicio = now();
  const [estado] = await db
    .select()
    .from(schema.syncState)
    .where(and(eq(schema.syncState.source, FONTE), eq(schema.syncState.resource, recurso.nome)));
  const completa =
    Boolean(opcoes.forcarCompleta) || !estado?.watermark || !estado.lastFullAt || inicio.getTime() - estado.lastFullAt.getTime() >= COMPLETA_A_CADA_MS;

  const itens = await recurso.listar(fonte, completa ? {} : { updatedSince: new Date(estado!.watermark!.getTime() - SOBREPOSICAO_MS) });
  const missoes = await db.select({ id: schema.missions.id, projectId: schema.missions.filtroappProjectId }).from(schema.missions);
  const porProjeto = new Map(missoes.map((m) => [m.projectId, m.id]));

  let watermark = estado?.watermark ?? null;
  let gravados = 0;
  let ignorados = 0;
  for (const x of itens) {
    const missionId = porProjeto.get(recurso.projeto(x));
    if (!missionId) {
      ignorados += 1;
      continue;
    }
    await recurso.gravar(db, x, missionId, inicio);
    gravados += 1;
    const atualizado = new Date(recurso.atualizado(x));
    if (!watermark || atualizado > watermark) watermark = atualizado;
  }
  // Completa: o que não veio sumiu do filtroAPP (só nas missões que o Omni conhece).
  const removidos = completa && missoes.length ? await recurso.limpar(db, itens, missoes.map((m) => m.id)) : 0;
  watermark ??= inicio;

  const fim = now();
  await db
    .insert(schema.syncState)
    .values({ source: FONTE, resource: recurso.nome, watermark, lastSuccessAt: fim, lastFullAt: completa ? fim : null })
    .onConflictDoUpdate({
      target: [schema.syncState.source, schema.syncState.resource],
      set: { watermark, lastSuccessAt: fim, ...(completa ? { lastFullAt: fim } : {}) },
    });
  return { completa, gravados, ignorados, removidos };
}

export type RecursoEntregaB = "medicoes" | "notas" | "romaneios" | "pendencias" | "descargas" | "qualidade" | "condicoes" | "alocacoes";
const RECURSOS = {
  medicoes: MEDICOES,
  notas: NOTAS,
  romaneios: ROMANEIOS,
  pendencias: PENDENCIAS,
  descargas: DESCARGAS,
  qualidade: QUALIDADE,
  condicoes: CONDICOES,
  alocacoes: ALOCACOES,
} as const;

/** Sincroniza os recursos pedidos (todos por padrão), um por vez (limite de 60 req/min do filtroAPP). */
export async function syncEntregaB(
  db: Db,
  fonte: FonteEntregaB,
  opcoes: { recursos?: RecursoEntregaB[]; forcarCompleta?: boolean; now?: () => Date } = {},
): Promise<Partial<Record<RecursoEntregaB, ResultadoRecurso>>> {
  const resultado: Partial<Record<RecursoEntregaB, ResultadoRecurso>> = {};
  for (const nome of opcoes.recursos ?? (Object.keys(RECURSOS) as RecursoEntregaB[])) {
    resultado[nome] = await sincronizar(db, fonte, RECURSOS[nome] as Recurso<unknown>, opcoes);
  }
  return resultado;
}

/** Tipos de evento do feed → recursos a sincronizar. */
export function recursosDosEventos(tipos: string[]): RecursoEntregaB[] {
  const r = new Set<RecursoEntregaB>();
  for (const t of tipos) {
    if (t.startsWith("medicao.")) r.add("medicoes");
    else if (t.startsWith("nota.")) r.add("notas");
    else if (t.startsWith("romaneio.")) r.add("romaneios");
    else if (t.startsWith("pendencia.")) r.add("pendencias");
    else if (t.startsWith("descarga.")) r.add("descargas");
    else if (t.startsWith("qualidade.")) r.add("qualidade");
    else if (t.startsWith("alocacao.")) r.add("alocacoes");
  }
  return [...r];
}

/** Avanço (%) e etapa de cada missão ativa no dia (revisão semanal: quanto andou na semana). */
export async function registrarAvanco(db: Db, cal: BusinessCalendar, agora: Date = new Date()): Promise<{ missoes: number }> {
  const dia = cal.dateKeyOf(agora);
  const r = await db.execute(sql`
    INSERT INTO mission_progress_history (mission_id, dia, progress_percent, stage)
    SELECT id, ${dia}::date, progress_percent, stage FROM missions WHERE is_active
    ON CONFLICT (mission_id, dia) DO UPDATE SET progress_percent = EXCLUDED.progress_percent, stage = EXCLUDED.stage`);
  return { missoes: r.rowCount ?? 0 };
}
