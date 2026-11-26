import { p95 } from "@omni/core";
import { withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { sql } from "drizzle-orm";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Administração → Saúde (E20, pilar 12.3; migration 0085). Números vitais num lugar só: web (medição da
 * E19), worker e filas (pg-boss), backup, banco, erros abertos e a sincronização com o filtroAPP.
 * Só quem administra (RLS e as funções do banco).
 */

type Faixa = { n: number; erros: number; mediaMs: number; p95Ms: number };
export type JobNaTela = {
  nome: string;
  ultimaOk: string | null;
  falhas24h: number;
  naFila: number;
  emExecucao: number;
};
export type Saude = {
  agora: string;
  web: {
    versao: string | null;
    memoriaMb: number;
    desde: string;
    ultimaHora: Faixa;
    ultimoDia: Faixa;
  };
  worker: {
    versao: string | null;
    memoriaMb: number;
    desde: string;
    visto: string;
  } | null;
  backup: {
    local: Estado;
    remoto: Estado;
    ensaio: Estado;
    visto: string;
  } | null;
  jobs: JobNaTela[];
  banco: {
    tamanhoMb: number;
    conexoes: number;
    conexoesMax: number;
    maiores: { tabela: string; mb: number }[];
  };
  errosAbertos: number;
  filtroapp: { missoesAtivas: number; ultimaSincronizacao: string | null };
};
type Estado = { status: string | null; em: string | null } | null;

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export const saude = createServerFn({ method: "GET" }).handler(
  async (): Promise<Saude> => {
    const personId = await personIdFromRequest(getRequest());
    if (!personId) throw new ErroParaTela("Sessão expirada. Entre de novo.");
    return withPerson(getPool(), personId, async (db) => {
      const admin = (
        await db.execute<{ ok: boolean }>(
          sql`SELECT app.has_profile('admin') AS ok`,
        )
      ).rows[0]?.ok;
      if (!admin)
        throw new ErroParaTela("Só quem administra vê a saúde do sistema.");

      const faixa = async (horas: number): Promise<Faixa> => {
        const { rows } = await db.execute<{
          n: string;
          soma: string;
          max: number;
          erros: string;
          faixas: number[] | null;
        }>(sql`
        SELECT coalesce(sum(n), 0) AS n, coalesce(sum(soma_ms), 0) AS soma, coalesce(max(max_ms), 0) AS max, coalesce(sum(erros), 0) AS erros,
               (SELECT array_agg(s ORDER BY i) FROM (SELECT i, sum(f) AS s FROM desempenho_rotas d2, unnest(d2.faixas) WITH ORDINALITY AS u(f, i)
                  WHERE d2.hora >= now() - make_interval(hours => ${horas}) GROUP BY i) x) AS faixas
          FROM desempenho_rotas WHERE hora >= now() - make_interval(hours => ${horas})`);
        const r = rows[0]!;
        const n = Number(r.n);
        return {
          n,
          erros: Number(r.erros),
          mediaMs: n ? Math.round(Number(r.soma) / n) : 0,
          p95Ms: p95((r.faixas ?? []).map(Number), r.max),
        };
      };

      const estados = (
        await db.execute<{
          chave: string;
          valor: Record<string, unknown>;
          atualizado_em: string;
        }>(sql`SELECT chave, valor, atualizado_em FROM estado_operacao`)
      ).rows;
      const w = estados.find((e) => e.chave === "worker");
      const b = estados.find((e) => e.chave === "backup");

      // Filas do pg-boss: última execução bem-sucedida, falhas nas 24 h e o que espera ou roda agora.
      // Sem a tabela (o worker nunca rodou neste banco), lista vazia.
      const temFila = (
        await db.execute<{ t: string | null }>(
          sql`SELECT to_regclass('pgboss.job')::text AS t`,
        )
      ).rows[0]?.t;
      const jobs = !temFila
        ? []
        : (
            await db.execute<{
              nome: string;
              ultima_ok: string | null;
              falhas: string;
              fila: string;
              rodando: string;
            }>(sql`
        SELECT name AS nome,
               max(completed_on) FILTER (WHERE state = 'completed') AS ultima_ok,
               count(*) FILTER (WHERE state = 'failed' AND coalesce(completed_on, created_on) > now() - interval '24 hours') AS falhas,
               count(*) FILTER (WHERE state IN ('created', 'retry') AND start_after <= now()) AS fila,
               count(*) FILTER (WHERE state = 'active') AS rodando
          FROM pgboss.job
         WHERE created_on > now() - interval '3 days' AND name NOT LIKE '\\_\\_%'
         GROUP BY name ORDER BY name`)
          ).rows.map((j) => ({
            nome: j.nome,
            ultimaOk: iso(j.ultima_ok),
            falhas24h: Number(j.falhas),
            naFila: Number(j.fila),
            emExecucao: Number(j.rodando),
          }));

      const banco = (
        await db.execute<{
          b: {
            tamanho_bytes: number;
            conexoes: number;
            conexoes_max: number;
            maiores_tabelas: { tabela: string; bytes: number }[];
          };
        }>(sql`SELECT app.saude_banco() AS b`)
      ).rows[0]!.b;
      const errosAbertos = Number(
        (
          await db.execute<{ n: string }>(
            sql`SELECT count(*) AS n FROM system_errors WHERE reviewed_at IS NULL`,
          )
        ).rows[0]!.n,
      );
      const fa = (
        await db.execute<{ ativas: string; ultima: string | null }>(
          sql`SELECT count(*) FILTER (WHERE is_active) AS ativas, max(project_synced_at) AS ultima FROM missions`,
        )
      ).rows[0]!;
      const mem = process.memoryUsage();

      return {
        agora: new Date().toISOString(),
        web: {
          versao: (process.env.OMNI_VERSAO || "").slice(0, 12) || null,
          memoriaMb: Math.round(mem.rss / 1_048_576),
          desde: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          ultimaHora: await faixa(1),
          ultimoDia: await faixa(24),
        },
        worker: w
          ? {
              versao: (w.valor.versao as string | null) ?? null,
              memoriaMb: Number(w.valor.memoriaMb ?? 0),
              desde: String(w.valor.desde ?? ""),
              visto: iso(w.atualizado_em)!,
            }
          : null,
        backup: b
          ? {
              local: (b.valor.local as Estado) ?? null,
              remoto: (b.valor.remoto as Estado) ?? null,
              ensaio: (b.valor.ensaio as Estado) ?? null,
              visto: iso(b.atualizado_em)!,
            }
          : null,
        jobs,
        banco: {
          tamanhoMb: Math.round(banco.tamanho_bytes / 1_048_576),
          conexoes: banco.conexoes,
          conexoesMax: banco.conexoes_max,
          maiores: banco.maiores_tabelas.map((t) => ({
            tabela: t.tabela,
            mb: Math.round((t.bytes / 1_048_576) * 10) / 10,
          })),
        },
        errosAbertos,
        filtroapp: {
          missoesAtivas: Number(fa.ativas),
          ultimaSincronizacao: iso(fa.ultima),
        },
      };
    });
  },
);
