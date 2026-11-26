import { withPerson } from "@omni/db";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";

import { getPool } from "../../server/db.ts";
import { personIdFromRequest } from "../../server/session.ts";

/**
 * Meus dados (LGPD art. 18, II; E15): o arquivo com o que o Omni guarda sobre a pessoa da sessão,
 * montado no banco por app.meus_dados (migration 0082, que também registra o pedido na auditoria) e,
 * no login interno, o usuário e o e-mail pessoal de recuperação (0078).
 */
export const Route = createFileRoute("/api/meus-dados")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return new Response("Sessão expirada. Entre de novo.", { status: 401, headers: { "Cache-Control": "no-store" } });
        const { rows, interno } = await withPerson(getPool(), personId, async (db) => ({
          rows: (await db.execute<{ d: Record<string, unknown> }>(sql`SELECT app.meus_dados() AS d`)).rows,
          // Login interno (0078): o usuário e o e-mail pessoal de recuperação (nunca o hash da senha).
          interno: (await db.execute<{ login: string; email_recuperacao: string | null }>(sql`SELECT * FROM app.minha_conta_interna()`)).rows[0],
        }));
        const dados = { ...(rows[0]?.d ?? {}), ...(interno ? { login_interno: { usuario: interno.login, email_pessoal_de_recuperacao: interno.email_recuperacao } } : {}) };
        const dia = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
        return new Response(JSON.stringify(dados, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="omni-meus-dados-${dia}.json"`,
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
