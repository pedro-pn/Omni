import { withPerson } from "@omni/db";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";

import { getPool } from "../../server/db.ts";
import { personIdFromRequest } from "../../server/session.ts";

/**
 * Meus dados (LGPD art. 18, II; E15): o arquivo com o que o Omni guarda sobre a pessoa da sessão,
 * montado no banco por app.meus_dados (migration 0082, que também registra o pedido na auditoria).
 */
export const Route = createFileRoute("/api/meus-dados")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return new Response("Sessão expirada. Entre de novo.", { status: 401, headers: { "Cache-Control": "no-store" } });
        const { rows } = await withPerson(getPool(), personId, (db) => db.execute<{ d: unknown }>(sql`SELECT app.meus_dados() AS d`));
        const dia = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
        return new Response(JSON.stringify(rows[0]?.d ?? {}, null, 2), {
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
