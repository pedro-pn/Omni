import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getPool } from "../../../server/db.ts";
import { getEnv } from "../../../server/env.ts";
const event = z.object({ identity: z.object({ numberId: z.uuid(), ownerId: z.uuid() }), expires: z.iso.datetime(), info: z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/), peer: z.string().regex(/^[1-9][0-9]{9,14}$/), direction: z.enum(["entrada", "saida"]),
  state: z.enum(["ligando", "recebendo", "tocando", "conectando", "ativa", "encerrada"]), createdAt: z.iso.datetime(), startedAt: z.iso.datetime().nullish(), endedAt: z.iso.datetime().nullish(),
  recording: z.boolean(), audio: z.boolean(), recordingError: z.boolean() }) });
export const Route = createFileRoute("/api/chamadas/eventos")({ server: { handlers: { POST: async ({ request }) => {
  const key = getEnv().CHAMADAS_SERVICO_KEY;
  const got = Buffer.from(request.headers.get("Authorization") ?? ""), expected = Buffer.from(`Bearer ${key}`);
  if (!key || got.length !== expected.length || !timingSafeEqual(got, expected)) return Response.json({ ok: false }, { status: 401 });
  if (Number(request.headers.get("content-length") ?? 0) > 8192) return new Response(null, { status: 413 });
  const body = await request.text(); if (body.length > 8192) return new Response(null, { status: 413 });
  let parsed; try { parsed = event.safeParse(JSON.parse(body)); } catch { return new Response(null, { status: 400 }); }
  if (!parsed.success) return new Response(null, { status: 400 });
  const { identity: i, info: c, expires } = parsed.data;
  try {
    const pool = getPool();
    const result = await pool.query<{ ok: boolean }>("select app.chamada_registrar($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as ok",
      [i.numberId, i.ownerId, c.id, c.peer, c.direction, c.state, c.createdAt, c.startedAt, c.endedAt, c.recording, c.audio, c.recordingError, expires]);
    const ok = Boolean(result.rows[0]?.ok);
    if (ok) {
      // Tempo real para a tela do dono (chamada tocando, atendida, encerrada) e aviso de chamada perdida.
      // Falha aqui não desfaz o registro: a tela também consulta o estado sozinha.
      await pool.query("select pg_notify('omni_chamadas', $1)", [JSON.stringify({ personId: i.ownerId, numberId: i.numberId, estado: c.state })]).catch(() => undefined);
      if (c.state === "encerrada" && c.direction === "entrada" && !c.startedAt) {
        await pool.query("select app.avisar_chamada_perdida($1, $2, $3)", [i.numberId, i.ownerId, c.id]).catch(() => undefined);
      }
    }
    return Response.json({ ok }, { status: ok ? 200 : 403 });
  } catch { return Response.json({ ok: false }, { status: 503 }); }
} } } });
