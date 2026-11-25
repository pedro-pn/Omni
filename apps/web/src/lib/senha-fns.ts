import { hashSessionToken, SESSION_TTL_HOURS, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { sessaoDoRequest, sessionTokenFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/** Trocar a própria senha do login interno (0078). Vale também com a senha provisória (antes de qualquer outra tela). */
export const trocarMinhaSenha = createServerFn({ method: "POST" })
  .validator(z.object({ atual: z.string().min(1).max(200), nova: z.string().min(1).max(200) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const request = getRequest();
    const s = await sessaoDoRequest(request);
    const token = sessionTokenFromRequest(request);
    if (!s || !token) throw new ErroParaTela("Sessão expirada. Entre de novo.");
    if (s.acesso !== "interno") throw new ErroParaTela("A senha desta conta é a da Microsoft.");
    try {
      await withPerson(getPool(), s.personId, (db) =>
        db.execute(sql`SELECT app.trocar_minha_senha(${data.atual}, ${data.nova}, ${hashSessionToken(token)}, ${`${SESSION_TTL_HOURS} hours`}::interval)`),
      );
    } catch (error) {
      const causa = String((error as Error & { cause?: Error }).cause?.message ?? (error as Error).message);
      if (/senha atual não confere/.test(causa)) throw new ErroParaTela("A senha atual não confere.");
      if (/senha fraca/.test(causa)) throw new ErroParaTela("Use pelo menos 10 caracteres, com letras e números.");
      if (/senha igual/.test(causa)) throw new ErroParaTela("A senha nova precisa ser diferente da atual.");
      throw error;
    }
    return { ok: true };
  });
