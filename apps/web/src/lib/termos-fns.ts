import { TERMOS } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { clientIp } from "../server/http.ts";
import { sessaoDoRequest } from "../server/session.ts";
import { HASH_TERMOS } from "../server/termos.ts";
import { ErroParaTela } from "./erros.ts";

/** Termo de uso (0051): a versão atual e quando a pessoa aceitou (null = ainda não). */
export const termoAtual = createServerFn({ method: "GET" }).handler(async (): Promise<{ versao: string; aceitoEm: string | null }> => {
  const s = await sessaoDoRequest(getRequest());
  if (!s) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  const [a] = await withPerson(getPool(), s.personId, (db) =>
    db
      .select({ em: schema.termsAcceptances.aceitoEm })
      .from(schema.termsAcceptances)
      .where(and(eq(schema.termsAcceptances.personId, s.personId), eq(schema.termsAcceptances.versao, TERMOS.versao))),
  );
  return { versao: TERMOS.versao, aceitoEm: a?.em.toISOString() ?? null };
});

/** Aceite da versão atual, com o SHA-256 do texto, o IP e o navegador (prova para a LGPD). */
export const aceitarTermos = createServerFn({ method: "POST" })
  .validator(z.object({ versao: z.string().max(20), concordo: z.literal(true) }))
  .handler(async ({ data }) => {
    const request = getRequest();
    const s = await sessaoDoRequest(request);
    if (!s) throw new ErroParaTela("Sessão expirada. Entre de novo.");
    if (data.versao !== TERMOS.versao) throw new ErroParaTela("O termo foi atualizado. Recarregue a página e leia a versão nova.");
    const ip = clientIp(request);
    const ipValido = ip && z.union([z.ipv4(), z.ipv6()]).safeParse(ip).success ? ip : null;
    await withPerson(getPool(), s.personId, (db) =>
      db.execute(sql`SELECT app.aceitar_termos(${TERMOS.versao}, ${HASH_TERMOS}, ${ipValido}::inet, ${request.headers.get("user-agent")?.slice(0, 400) ?? null})`),
    );
    return { ok: true };
  });
