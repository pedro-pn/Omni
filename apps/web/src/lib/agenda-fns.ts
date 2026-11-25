import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { agendaConfigurada, enderecosDaAgenda } from "../server/agenda.ts";
import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/** Link privado da agenda das tarefas (.ics) — como o "Calendário Apple" do Foco. */

export type StatusAgenda = { configurada: boolean; ativa: boolean; https: string | null; webcal: string | null; criadaEm: string | null; ultimoAcesso: string | null };

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

const status = (f: typeof schema.calendarFeeds.$inferSelect | undefined): StatusAgenda => {
  const links = f ? enderecosDaAgenda(f) : null;
  return { configurada: true, ativa: Boolean(f), https: links?.https ?? null, webcal: links?.webcal ?? null, criadaEm: f?.createdAt.toISOString() ?? null, ultimoAcesso: f?.lastAccessedAt?.toISOString() ?? null };
};

export const statusAgenda = createServerFn({ method: "GET" }).handler(async (): Promise<StatusAgenda> => {
  const personId = await pessoa();
  if (!agendaConfigurada()) return { configurada: false, ativa: false, https: null, webcal: null, criadaEm: null, ultimoAcesso: null };
  const [f] = await withPerson(getPool(), personId, (db) => db.select().from(schema.calendarFeeds).where(eq(schema.calendarFeeds.personId, personId)));
  return status(f);
});

/** Cria o link (ou troca: o anterior para de abrir). */
export const criarAgenda = createServerFn({ method: "POST" })
  .validator(z.object({ trocar: z.boolean().default(false) }))
  .handler(async ({ data }): Promise<StatusAgenda> => {
    const personId = await pessoa();
    if (!agendaConfigurada()) throw new ErroParaTela("A agenda por link não está configurada neste ambiente.");
    return withPerson(getPool(), personId, async (db) => {
      const t = schema.calendarFeeds;
      if (data.trocar) await db.delete(t).where(eq(t.personId, personId));
      const [atual] = await db.select().from(t).where(eq(t.personId, personId));
      if (atual) return status(atual);
      const [novo] = await db.insert(t).values({ personId, signedSubject: personId, signedCreated: new Date().toISOString() }).returning();
      return status(novo);
    });
  });

export const desativarAgenda = createServerFn({ method: "POST" }).handler(async () => {
  const personId = await pessoa();
  await withPerson(getPool(), personId, (db) => db.delete(schema.calendarFeeds).where(eq(schema.calendarFeeds.personId, personId)));
  return { ok: true };
});
