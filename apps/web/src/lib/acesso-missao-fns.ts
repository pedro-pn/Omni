import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Acesso à missão (0045): Diretoria, Administração e Gerentes veem todas; os
 * demais, só as associadas (responsáveis e equipe no filtroAPP, canais, função
 * da IA) e as que a Diretoria ou a Administração liberarem aqui.
 */

export type AcessoDaMissao = {
  podeLiberar: boolean;
  liberados: Array<{ id: string; nome: string; email: string; por: string | null; em: string }>;
  pessoas: Array<{ id: string; nome: string; email: string }>;
};

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

export const acessoDaMissao = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<AcessoDaMissao> => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const [r] = (await db.execute<{ ok: boolean }>(sql`SELECT (app.has_profile('diretoria') OR app.has_profile('admin')) AS ok`)).rows;
      if (!r?.ok) return { podeLiberar: false, liberados: [], pessoas: [] };
      const quem = alias(schema.people, "quem");
      const por = alias(schema.people, "por");
      const [liberados, pessoas] = await Promise.all([
        db
          .select({ id: quem.id, nome: quem.displayName, email: quem.email, por: por.displayName, em: schema.missionViewers.addedAt })
          .from(schema.missionViewers)
          .innerJoin(quem, eq(quem.id, schema.missionViewers.personId))
          .leftJoin(por, eq(por.id, schema.missionViewers.addedBy))
          .where(eq(schema.missionViewers.missionId, data.missionId))
          .orderBy(asc(quem.displayName)),
        db.select({ id: schema.people.id, nome: schema.people.displayName, email: schema.people.email }).from(schema.people).where(eq(schema.people.active, true)).orderBy(asc(schema.people.displayName)),
      ]);
      return {
        podeLiberar: true,
        liberados: liberados.map((l) => ({ ...l, email: String(l.email), em: l.em.toISOString() })),
        pessoas: pessoas.map((p) => ({ ...p, email: String(p.email) })),
      };
    });
  });

export const liberarMissao = createServerFn({ method: "POST" })
  .validator(z.object({ missionId: z.uuid(), personId: z.uuid(), liberar: z.boolean() }))
  .handler(async ({ data }) => {
    const meuId = await pessoa();
    try {
      await withPerson(getPool(), meuId, async (db) => {
        const v = schema.missionViewers;
        if (data.liberar) {
          await db.insert(v).values({ missionId: data.missionId, personId: data.personId, addedBy: meuId }).onConflictDoNothing();
        } else {
          await db.delete(v).where(and(eq(v.missionId, data.missionId), eq(v.personId, data.personId)));
        }
        await db.insert(schema.auditLog).values({
          actorPersonId: meuId,
          action: data.liberar ? "missao.acesso_liberado" : "missao.acesso_retirado",
          entityType: "mission",
          entityId: data.missionId,
          metadata: { personId: data.personId },
        });
      });
    } catch {
      throw new ErroParaTela("Só a Diretoria e a Administração liberam o acesso a uma missão.");
    }
    return { ok: true };
  });
