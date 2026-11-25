import { MODULOS, NOME_DO_MODULO, PERFIS, type Modulo, type PerfilCodigo } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/** Administração → Módulos (0071): liberar cada módulo para todos, só alguns ou ninguém. */

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

export type ConfigModulo = { modulo: Modulo; nome: string; modo: "todos" | "restrito" | "ninguem"; perfis: string[]; pessoas: string[] };

export const configuracaoDosModulos = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ modulos: ConfigModulo[]; pessoas: { id: string; nome: string; email: string }[]; podeMudar: boolean }> => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const linhas = await db.select().from(schema.moduleAccess);
      const pessoas = await db
        .select({ id: schema.people.id, nome: schema.people.displayName, email: schema.people.email })
        .from(schema.people)
        .where(eq(schema.people.active, true))
        .orderBy(asc(schema.people.displayName));
      const perfis = await db.select({ p: schema.personProfiles.profile }).from(schema.personProfiles).where(eq(schema.personProfiles.personId, personId));
      return {
        modulos: MODULOS.map((m) => {
          const l = linhas.find((x) => x.module === m);
          return { modulo: m, nome: NOME_DO_MODULO[m], modo: l?.mode ?? "todos", perfis: l?.profiles ?? [], pessoas: l?.people ?? [] };
        }),
        pessoas,
        podeMudar: perfis.some((p) => p.p === "admin"),
      };
    });
  },
);

const CODIGOS = Object.keys(PERFIS) as [PerfilCodigo, ...PerfilCodigo[]];

export const salvarModulo = createServerFn({ method: "POST" })
  .validator(
    z.object({
      modulo: z.enum(MODULOS),
      modo: z.enum(["todos", "restrito", "ninguem"]),
      perfis: z.array(z.enum(CODIGOS)).max(20).default([]),
      pessoas: z.array(z.uuid()).max(500).default([]),
    }),
  )
  .handler(async ({ data }) => {
    const personId = await pessoa();
    if (data.modo === "restrito" && !data.perfis.length && !data.pessoas.length) throw new ErroParaTela("Escolha ao menos um perfil ou uma pessoa.");
    const valores = { mode: data.modo, profiles: data.modo === "restrito" ? data.perfis : [], people: data.modo === "restrito" ? data.pessoas : [], updatedBy: personId, updatedAt: new Date() };
    try {
      await withPerson(getPool(), personId, (db) =>
        db
          .insert(schema.moduleAccess)
          .values({ module: data.modulo, ...valores })
          .onConflictDoUpdate({ target: schema.moduleAccess.module, set: valores }),
      );
    } catch {
      throw new ErroParaTela("Só quem administra o Omni muda a liberação dos módulos.");
    }
    return { ok: true };
  });
