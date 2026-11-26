import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { StatusDeBackup, StatusDeEnsaio } from "@omni/core";
import { schema, type Db } from "@omni/db";
import { sql } from "drizzle-orm";

/**
 * Painel de saúde (E20, pilar 12.3; migration 0085). Job `saude` (5 min): grava em estado_operacao o
 * que o web não enxerga: o próprio worker (versão, memória, desde quando) e, com OPERACAO_STATUS=ligado,
 * o resumo dos arquivos de status do backup e do ensaio (só situação e horário, sem caminho nem erro).
 */
async function lerJson<T>(caminho: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(caminho, "utf8")) as T;
  } catch {
    return null;
  }
}

const resumo = (s: (StatusDeBackup & StatusDeEnsaio) | null) =>
  s ? { status: s.status ?? null, em: s.finishedAt ?? null } : null;

async function gravar(
  db: Db,
  chave: "worker" | "backup",
  valor: Record<string, unknown>,
) {
  const e = schema.estadoOperacao;
  await db
    .insert(e)
    .values({ chave, valor })
    .onConflictDoUpdate({
      target: e.chave,
      set: { valor, atualizadoEm: sql`now()` },
    });
}

export async function registrarSaude(
  db: Db,
  pastaStatus: string | null,
  agora = new Date(),
): Promise<Record<string, unknown>> {
  const m = process.memoryUsage();
  const worker = {
    versao: (process.env.OMNI_VERSAO || "").slice(0, 12) || null,
    memoriaMb: Math.round(m.rss / 1_048_576),
    heapMb: Math.round(m.heapUsed / 1_048_576),
    desde: new Date(agora.getTime() - process.uptime() * 1000).toISOString(),
  };
  await gravar(db, "worker", worker);
  if (!pastaStatus) return { worker };
  const [local, remoto, ensaio] = await Promise.all([
    lerJson<StatusDeBackup>(join(pastaStatus, "backup-latest.json")),
    lerJson<StatusDeBackup>(join(pastaStatus, "backup-remoto-latest.json")),
    lerJson<StatusDeEnsaio>(join(pastaStatus, "restore-latest.json")),
  ]);
  const backup = {
    local: resumo(local),
    remoto: resumo(remoto),
    ensaio: resumo(ensaio),
  };
  await gravar(db, "backup", backup);
  return { worker, backup };
}
