import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/** O sino: avisos da pessoa logada (RLS: cada um vê e marca só os seus). */

export type Aviso = {
  id: string;
  tipo: (typeof schema.TIPOS_AVISO)[number];
  titulo: string;
  texto: string;
  tarefaId: string | null;
  missaoId: string | null;
  em: string;
  lido: boolean;
};

async function exigirPessoa(): Promise<string> {
  const personId = await personIdFromRequest(getRequest());
  if (!personId) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return personId;
}

export const listarAvisos = createServerFn({ method: "GET" }).handler(async (): Promise<{ avisos: Aviso[]; naoLidos: number }> => {
  const meuId = await exigirPessoa();
  return withPerson(getPool(), meuId, async (db) => {
    const [linhas, [contagem]] = await Promise.all([
      db.select().from(schema.notifications).orderBy(desc(schema.notifications.createdAt)).limit(50),
      db.select({ n: sql<number>`count(*)::int` }).from(schema.notifications).where(isNull(schema.notifications.readAt)),
    ]);
    return {
      avisos: linhas.map((n) => ({
        id: n.id,
        tipo: n.kind,
        titulo: n.title,
        texto: n.body,
        tarefaId: n.taskId,
        missaoId: n.missionId,
        em: n.createdAt.toISOString(),
        lido: n.readAt !== null,
      })),
      naoLidos: contagem?.n ?? 0,
    };
  });
});

export const marcarAvisosLidos = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid().optional() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const meuId = await exigirPessoa();
    await withPerson(getPool(), meuId, (db) =>
      db
        .update(schema.notifications)
        .set({ readAt: new Date() })
        .where(and(isNull(schema.notifications.readAt), data.id ? eq(schema.notifications.id, data.id) : undefined)),
    );
    return { ok: true as const };
  });
