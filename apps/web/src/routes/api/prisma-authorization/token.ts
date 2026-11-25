import { createFileRoute } from "@tanstack/react-router";

import { tratarAutorizacaoPrisma } from "../../../server/autorizacao-prisma.ts";
import { getPool } from "../../../server/db.ts";

export const Route = createFileRoute("/api/prisma-authorization/token")({
  server: { handlers: { POST: ({ request }) => tratarAutorizacaoPrisma(request, getPool(), "token") } },
});
