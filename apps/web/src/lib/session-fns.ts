import { withPerson, schema } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";

import { getPool } from "../server/db.ts";
import { ambienteDe, getEnv } from "../server/env.ts";
import { microsoftLoginEnabled } from "../server/microsoft.ts";
import { sessaoDoRequest } from "../server/session.ts";
import type { Modulo } from "@omni/core";
import { modulosLiberados } from "../server/modulos.ts";

export type Me = {
  id: string;
  displayName: string;
  email: string;
  jobTitle: string | null;
  profiles: string[];
  /** "staging" mostra a marca STAGING na tela. */
  ambiente: "desenvolvimento" | "staging" | "producao";
  /** Falta aceitar a versão atual do termo de uso: as telas mandam para /termos. */
  termosPendentes: boolean;
  /** Módulos liberados para a pessoa (0071; Administração → Módulos). */
  modulos: Modulo[];
  /** Login interno com a senha provisória (0078): as telas mandam para /conta/senha. */
  senhaPendente: boolean;
  /** Conta Microsoft da empresa ou login interno (sem caixa de e-mail). */
  acesso: "microsoft" | "interno";
};

/** Pessoa da sessão atual, ou null. Tudo lido pelo papel omni_app, com RLS. */
export const getMe = createServerFn({ method: "GET" }).handler(async (): Promise<Me | null> => {
  const sessao = await sessaoDoRequest(getRequest());
  if (!sessao) return null;
  const { personId, termosPendentes, senhaPendente, acesso } = sessao;
  const modulos = termosPendentes || senhaPendente ? [] : await modulosLiberados(personId);
  return withPerson(getPool(), personId, async (db) => {
    const [person] = await db.select().from(schema.people).where(eq(schema.people.id, personId));
    if (!person) return null;
    const profiles = await db
      .select({ profile: schema.personProfiles.profile })
      .from(schema.personProfiles)
      .where(eq(schema.personProfiles.personId, personId));
    return {
      id: person.id,
      displayName: person.displayName,
      email: person.email,
      jobTitle: person.jobTitle,
      profiles: profiles.map((p) => p.profile),
      ambiente: ambienteDe(getEnv()),
      termosPendentes,
      modulos,
      senhaPendente,
      acesso,
    };
  });
});

export const getLoginOptions = createServerFn({ method: "GET" }).handler(async () => {
  const env = getEnv();
  return {
    microsoft: microsoftLoginEnabled(),
    dev: env.AUTH_DEV_LOGIN === "on" && env.NODE_ENV !== "production" && ambienteDe(env) === "desenvolvimento",
  };
});
