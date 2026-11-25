import { MODULOS, NOME_DO_MODULO, type Modulo } from "@omni/core";
import { withPerson } from "@omni/db";
import { sql } from "drizzle-orm";

import { ErroParaTela } from "../lib/erros.ts";
import { getPool } from "./db.ts";

export { MODULOS, NOME_DO_MODULO, type Modulo };

/** Módulos liberados para a pessoa (a regra está no banco: app.modulo_liberado). */
export async function modulosLiberados(personId: string): Promise<Modulo[]> {
  const r = await withPerson(getPool(), personId, (db) =>
    db.execute<{ m: Modulo }>(sql`SELECT m FROM unnest(${`{${MODULOS.join(",")}}`}::text[]) AS m WHERE app.modulo_liberado(m)`),
  );
  return r.rows.map((x) => x.m);
}

/** Recusa a chamada quando o módulo não está liberado para a pessoa. */
export async function exigirModulo(personId: string, modulo: Modulo): Promise<void> {
  const r = await withPerson(getPool(), personId, (db) => db.execute<{ ok: boolean }>(sql`SELECT app.modulo_liberado(${modulo}) AS ok`));
  if (!r.rows[0]?.ok) throw new ErroParaTela(`${NOME_DO_MODULO[modulo]} ainda não foi liberado para você no Omni.`);
}
