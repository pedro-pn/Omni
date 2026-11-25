import { schema, withPerson, type Db } from "@omni/db";
import { getRequest } from "@tanstack/react-start/server";

import { ErroParaTela } from "../lib/erros.ts";
import { getPool } from "./db.ts";
import { personIdFromRequest } from "./session.ts";

/** Ajudantes da Administração (só servidor): sessão de quem administra e registro na auditoria. */

export class AdminError extends ErroParaTela {}

export async function comoAdministrador<T>(fn: (db: Db, meuId: string) => Promise<T>): Promise<T> {
  const meuId = await personIdFromRequest(getRequest());
  if (!meuId) throw new AdminError("Sessão expirada. Entre de novo.");
  try {
    return await withPerson(getPool(), meuId, (db) => fn(db, meuId));
  } catch (error) {
    if (error instanceof AdminError) throw error;
    const causa = String((error as Error & { cause?: Error }).cause?.message ?? (error as Error).message);
    if (/row-level security|permission denied/.test(causa)) throw new AdminError("Você não tem permissão para essa alteração.");
    throw error;
  }
}

export async function auditar(db: Db, meuId: string, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) {
  await db.insert(schema.auditLog).values({ actorPersonId: meuId, action, entityType, entityId, metadata });
}
