import { createFileRoute } from "@tanstack/react-router";

import { tratarApiV1 } from "../../../server/api-v1.ts";
import { getPool } from "../../../server/db.ts";

/** API de tarefas compatível com a do Foco (ver server/api-v1.ts). */
const tratar = ({ request }: { request: Request }) => tratarApiV1(request, getPool());

export const Route = createFileRoute("/api/v1/$")({
  server: { handlers: { GET: tratar, POST: tratar, PATCH: tratar, DELETE: tratar, OPTIONS: tratar } },
});
