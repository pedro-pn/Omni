import { p95 } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { gte, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/** Administração → Desempenho (E19, migration 0084). Só quem administra (RLS e as funções do banco). */

export type RotaNaTela = { rota: string; chamadas: number; mediaMs: number; p95Ms: number; maxMs: number; erros: number; totalS: number };
export type ConsultaLenta = { consulta: string; chamadas: number; mediaMs: number; maxMs: number; totalMs: number; linhas: number };
export type Desempenho = { horas: number; rotas: RotaNaTela[]; consultasLigadas: boolean; consultas: ConsultaLenta[] };

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

export const desempenho = createServerFn({ method: "GET" })
  .validator(z.object({ horas: z.number().int().min(1).max(24 * 30) }))
  .handler(async ({ data }): Promise<Desempenho> => {
    const personId = await pessoa();
    const d = schema.desempenhoRotas;
    return withPerson(getPool(), personId, async (db) => {
      const admin = (await db.execute<{ ok: boolean }>(sql`SELECT app.has_profile('admin') AS ok`)).rows[0]?.ok;
      if (!admin) throw new ErroParaTela("Só quem administra vê o desempenho.");
      const desde = new Date(Date.now() - data.horas * 3_600_000);
      const linhas = await db
        .select({ rota: d.rota, n: d.n, somaMs: d.somaMs, maxMs: d.maxMs, erros: d.erros, faixas: d.faixas })
        .from(d)
        .where(gte(d.hora, desde));
      const porRota = new Map<string, { n: number; soma: number; max: number; erros: number; faixas: number[] }>();
      for (const l of linhas) {
        const a = porRota.get(l.rota) ?? { n: 0, soma: 0, max: 0, erros: 0, faixas: Array(8).fill(0) };
        a.n += l.n;
        a.soma += l.somaMs;
        a.max = Math.max(a.max, l.maxMs);
        a.erros += l.erros;
        a.faixas = a.faixas.map((v, i) => v + (l.faixas[i] ?? 0));
        porRota.set(l.rota, a);
      }
      const rotas = [...porRota.entries()]
        .map(([rota, a]) => ({ rota, chamadas: a.n, mediaMs: Math.round(a.soma / a.n), p95Ms: p95(a.faixas, a.max), maxMs: a.max, erros: a.erros, totalS: Math.round(a.soma / 1000) }))
        .sort((x, y) => y.p95Ms - x.p95Ms || y.totalS - x.totalS);
      const consultasLigadas = Boolean((await db.execute<{ ok: boolean }>(sql`SELECT app.consultas_lentas_ligadas() AS ok`)).rows[0]?.ok);
      const consultas = consultasLigadas
        ? (
            await db.execute<{ consulta: string; chamadas: string; media_ms: string; max_ms: string; total_ms: string; linhas: string }>(
              sql`SELECT * FROM app.consultas_lentas(15)`,
            )
          ).rows.map((c) => ({
            consulta: c.consulta,
            chamadas: Number(c.chamadas),
            mediaMs: Number(c.media_ms),
            maxMs: Number(c.max_ms),
            totalMs: Number(c.total_ms),
            linhas: Number(c.linhas),
          }))
        : [];
      return { horas: data.horas, rotas, consultasLigadas, consultas };
    });
  });
