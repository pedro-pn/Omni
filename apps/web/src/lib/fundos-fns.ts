import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/** Plano de fundo das conversas de cada pessoa (0061): geral e por conversa. Vale em todos os aparelhos dela. */

export const CORES_DE_FUNDO = ["padrao", "areia", "menta", "ceu", "lavanda", "rosa", "pessego", "cinza", "grafite"] as const;
export const PADROES_DE_FUNDO = ["nenhum", "pontos", "grade", "listras"] as const;
export const FUNDO = z
  .string()
  .regex(/^((padrao|areia|menta|ceu|lavanda|rosa|pessego|cinza|grafite)|#[0-9a-f]{6})\|(nenhum|pontos|grade|listras)$/, "Plano de fundo inválido.");

export type MeusFundos = { geral: string | null; conversas: Record<string, string> };

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

export const meusFundos = createServerFn({ method: "GET" }).handler(async (): Promise<MeusFundos> => {
  const personId = await pessoa();
  const linhas = await withPerson(getPool(), personId, (db) => db.select({ chatId: schema.whatsappFundos.chatId, fundo: schema.whatsappFundos.fundo }).from(schema.whatsappFundos));
  return {
    geral: linhas.find((l) => l.chatId === null)?.fundo ?? null,
    conversas: Object.fromEntries(linhas.filter((l) => l.chatId).map((l) => [l.chatId!, l.fundo])),
  };
});

/** Grava (ou tira, com `fundo` nulo) o plano de fundo geral (`chatId` nulo) ou de uma conversa. */
export const salvarFundo = createServerFn({ method: "POST" })
  .validator(z.object({ chatId: z.uuid().nullable(), fundo: FUNDO.nullable() }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    const f = schema.whatsappFundos;
    await withPerson(getPool(), personId, async (db) => {
      await db.delete(f).where(and(eq(f.personId, personId), data.chatId ? eq(f.chatId, data.chatId) : isNull(f.chatId)));
      if (data.fundo) await db.insert(f).values({ personId, chatId: data.chatId, fundo: data.fundo });
    }).catch((error: unknown) => {
      if (data.chatId) throw new ErroParaTela("Não foi possível mudar o fundo desta conversa.");
      throw error;
    });
    return { ok: true };
  });
