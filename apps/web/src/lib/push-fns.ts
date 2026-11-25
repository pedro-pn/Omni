import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { getEnv } from "../server/env.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Notificações no celular/computador (PWA + Web Push). O navegador inscreve o
 * aparelho com a chave pública VAPID; o worker envia (avisos do sino, mensagens
 * dos canais que a pessoa acompanha e do WhatsApp). Cada pessoa escolhe o que recebe.
 */

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

export type ConfigPush = { chavePublica: string | null; aparelhos: number; canais: boolean; whatsapp: boolean; email: boolean };

export const configPush = createServerFn({ method: "GET" }).handler(async (): Promise<ConfigPush> => {
  const personId = await pessoa();
  return withPerson(getPool(), personId, async (db) => {
    const [prefs] = await db.select().from(schema.pushPreferences).where(eq(schema.pushPreferences.personId, personId));
    const [n] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM push_subscriptions WHERE person_id = ${personId}::uuid`)).rows;
    return { chavePublica: getEnv().WEB_PUSH_PUBLIC_KEY ?? null, aparelhos: n?.n ?? 0, canais: prefs?.canais ?? true, whatsapp: prefs?.whatsapp ?? true, email: prefs?.email ?? true };
  });
});

const inscricao = z.object({
  endpoint: z.url().startsWith("https://").max(1000),
  p256dh: z.string().regex(/^[A-Za-z0-9_-]{40,200}$/),
  auth: z.string().regex(/^[A-Za-z0-9_-]{10,100}$/),
});

export const inscreverAparelho = createServerFn({ method: "POST" })
  .validator(inscricao)
  .handler(async ({ data }) => {
    const personId = await pessoa();
    const ua = getRequest().headers.get("user-agent") ?? null;
    await withPerson(getPool(), personId, (db) => db.execute(sql`SELECT app.registrar_push(${data.endpoint}, ${data.p256dh}, ${data.auth}, ${ua})`));
    return { ok: true };
  });

export const desinscreverAparelho = createServerFn({ method: "POST" })
  .validator(z.object({ endpoint: z.url().max(1000) }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    await withPerson(getPool(), personId, (db) =>
      db.delete(schema.pushSubscriptions).where(and(eq(schema.pushSubscriptions.endpoint, data.endpoint), eq(schema.pushSubscriptions.personId, personId))),
    );
    return { ok: true };
  });

export const salvarPreferenciasPush = createServerFn({ method: "POST" })
  .validator(z.object({ canais: z.boolean(), whatsapp: z.boolean(), email: z.boolean().default(true) }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    await withPerson(getPool(), personId, (db) =>
      db
        .insert(schema.pushPreferences)
        .values({ personId, ...data })
        .onConflictDoUpdate({ target: schema.pushPreferences.personId, set: { ...data, updatedAt: new Date() } }),
    );
    return { ok: true };
  });

// ---------------------------------------------------------------- e-mail (0040)

export type PreferenciasEmail = { lembretes: boolean; atribuicoes: boolean; mencoes: boolean; comentarios: boolean; concluidas: boolean; resumoSemanal: boolean };
const prefsEmail = z.object({ lembretes: z.boolean(), atribuicoes: z.boolean(), mencoes: z.boolean(), comentarios: z.boolean(), concluidas: z.boolean(), resumoSemanal: z.boolean() });

/** O que a pessoa recebe por e-mail (sem linha: o padrão do Foco) e se o envio está ligado neste ambiente. */
export const preferenciasEmail = createServerFn({ method: "GET" }).handler(async (): Promise<PreferenciasEmail & { modo: "desligado" | "ensaio" | "real" }> => {
  const personId = await pessoa();
  const [p] = await withPerson(getPool(), personId, (db) => db.select().from(schema.emailPreferences).where(eq(schema.emailPreferences.personId, personId)));
  const padrao = { lembretes: true, atribuicoes: true, mencoes: true, comentarios: true, concluidas: false, resumoSemanal: true };
  const atual = p ?? padrao;
  return {
    lembretes: atual.lembretes,
    atribuicoes: atual.atribuicoes,
    mencoes: atual.mencoes,
    comentarios: atual.comentarios,
    concluidas: atual.concluidas,
    resumoSemanal: atual.resumoSemanal,
    modo: getEnv().EMAIL_ENVIO,
  };
});

export const salvarPreferenciasEmail = createServerFn({ method: "POST" })
  .validator(prefsEmail)
  .handler(async ({ data }) => {
    const personId = await pessoa();
    await withPerson(getPool(), personId, (db) =>
      db
        .insert(schema.emailPreferences)
        .values({ personId, ...data })
        .onConflictDoUpdate({ target: schema.emailPreferences.personId, set: { ...data, updatedAt: new Date() } }),
    );
    return { ok: true };
  });

/** Cria um aviso de teste para a própria pessoa (o worker manda o push). */
export const testarNotificacao = createServerFn({ method: "POST" }).handler(async () => {
  const personId = await pessoa();
  await withPerson(getPool(), personId, (db) => db.execute(sql`SELECT app.aviso_de_teste()`));
  return { ok: true };
});
