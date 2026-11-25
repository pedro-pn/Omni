import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/** Pastas e arquivo pessoais das listas de Missões e Conversas (0059). Só da própria pessoa (RLS). */

export type TipoOrganizado = "missao" | "conversa";
export type Organizacao = {
  pastas: { id: string; nome: string }[];
  /** Por item: pasta (ou null) e se está arquivado. Item fora daqui: sem pasta, não arquivado. */
  itens: Record<string, { pastaId: string | null; arquivado: boolean }>;
};

const tipo = z.enum(["missao", "conversa"]);

async function eu(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

export const organizacao = createServerFn({ method: "GET" })
  .validator(z.object({ tipo }))
  .handler(async ({ data }): Promise<Organizacao> => {
    const me = await eu();
    return withPerson(getPool(), me, async (db) => {
      const pastas = await db
        .select({ id: schema.pastasPessoais.id, nome: schema.pastasPessoais.nome })
        .from(schema.pastasPessoais)
        .where(eq(schema.pastasPessoais.tipo, data.tipo))
        .orderBy(asc(schema.pastasPessoais.ordem), asc(schema.pastasPessoais.nome));
      const itens = await db.select().from(schema.organizacaoPessoal).where(eq(schema.organizacaoPessoal.tipo, data.tipo));
      return {
        pastas,
        itens: Object.fromEntries(itens.map((i) => [i.itemId, { pastaId: i.pastaId, arquivado: i.arquivadoEm !== null }])),
      };
    });
  });

export const criarPasta = createServerFn({ method: "POST" })
  .validator(z.object({ tipo, nome: z.string().trim().min(1, "Dê um nome à pasta.").max(60, "Nome muito longo.") }))
  .handler(async ({ data }) => {
    const me = await eu();
    try {
      const [p] = await withPerson(getPool(), me, (db) =>
        db.insert(schema.pastasPessoais).values({ personId: me, tipo: data.tipo, nome: data.nome }).returning({ id: schema.pastasPessoais.id }),
      );
      return { id: p!.id };
    } catch {
      throw new ErroParaTela("Já existe uma pasta com esse nome.");
    }
  });

export const renomearPasta = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid(), nome: z.string().trim().min(1, "Dê um nome à pasta.").max(60) }))
  .handler(async ({ data }) => {
    const me = await eu();
    try {
      await withPerson(getPool(), me, (db) => db.update(schema.pastasPessoais).set({ nome: data.nome }).where(eq(schema.pastasPessoais.id, data.id)));
    } catch {
      throw new ErroParaTela("Já existe uma pasta com esse nome.");
    }
    return { ok: true };
  });

/** Apaga a pasta; os itens dela ficam sem pasta (não são apagados nem arquivados). */
export const apagarPasta = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const me = await eu();
    await withPerson(getPool(), me, (db) => db.delete(schema.pastasPessoais).where(eq(schema.pastasPessoais.id, data.id)));
    return { ok: true };
  });

/** Põe o item numa pasta (null = sem pasta) e/ou arquiva/desarquiva. */
export const organizarItem = createServerFn({ method: "POST" })
  .validator(z.object({ tipo, itemId: z.uuid(), pastaId: z.uuid().nullable().optional(), arquivar: z.boolean().optional() }))
  .handler(async ({ data }) => {
    const me = await eu();
    const t = schema.organizacaoPessoal;
    await withPerson(getPool(), me, async (db) => {
      const [atual] = await db.select().from(t).where(and(eq(t.tipo, data.tipo), eq(t.itemId, data.itemId)));
      const pastaId = data.pastaId !== undefined ? data.pastaId : (atual?.pastaId ?? null);
      const arquivadoEm = data.arquivar === undefined ? (atual?.arquivadoEm ?? null) : data.arquivar ? new Date() : null;
      if (!pastaId && !arquivadoEm) {
        await db.delete(t).where(and(eq(t.tipo, data.tipo), eq(t.itemId, data.itemId)));
        return;
      }
      await db
        .insert(t)
        .values({ personId: me, tipo: data.tipo, itemId: data.itemId, pastaId, arquivadoEm, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [t.personId, t.tipo, t.itemId], set: { pastaId, arquivadoEm, updatedAt: new Date() } });
    });
    return { ok: true };
  });
