import { schema, withPerson } from "@omni/db";
import { chaveMestra, decifrarTrecho, desembrulharChave, trechoCifrado } from "@omni/integrations/gravacoes";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getPool } from "../../../../server/db.ts";
import { getEnv } from "../../../../server/env.ts";
import { getGraph } from "../../../../server/graph.ts";
import { personIdFromRequest } from "../../../../server/session.ts";
import { servicoChamadas } from "../../../../server/chamadas.ts";
import { faixaPedida } from "../../../../server/gravacoes.ts";
import { registrarDownload } from "../../../../server/downloads.ts";

/**
 * Áudio de uma gravação, só para quem pode ouvir (RLS: o dono e quem recebeu o
 * compartilhamento). Recém-terminada, vem do serviço de voz (WAV). Arquivada
 * (0052–0053), vem cifrada do SharePoint: o servidor abre a chave da gravação com a
 * chave mestra e decifra só o trecho que o player pede (Range), enquanto chega.
 */

const cabecalhos = (tipo: "m4a" | "wav") => ({ "Content-Type": tipo === "m4a" ? "audio/mp4" : "audio/wav", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename="gravacao.${tipo}"`, "Accept-Ranges": "bytes" });

export const Route = createFileRoute("/api/chamadas/gravacoes/$callId")({ server: { handlers: { GET: async ({ request, params }) => {
  const me = await personIdFromRequest(request); if (!me) return new Response(null, { status: 401 });
  if (!z.uuid().safeParse(params.callId).success) return new Response(null, { status: 400 });
  const [call] = await withPerson(getPool(), me, db => db.select().from(schema.whatsappCalls).where(eq(schema.whatsappCalls.id, params.callId)));
  if (!call?.audio || call.deletedAt || call.expiresAt <= new Date()) return new Response(null, { status: 404 });
  await registrarDownload(request, me, "gravacao", call.id);
  const range = request.headers.get("Range");
  try {
    if (call.arquivoLocal === "sharepoint") {
      const graph = getGraph();
      const mestra = getEnv().GRAVACOES_CHAVE_MESTRA;
      if (!graph || !mestra) return new Response(null, { status: 503 });
      if (!call.spDriveId || !call.spItemId || !call.chaveCifrada || !call.arquivoBytes) return new Response(null, { status: 404 });
      const total = call.arquivoBytes;
      const faixa = faixaPedida(range, total);
      if (faixa === null) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
      const [inicio, fim] = faixa ?? [0, total - 1];
      const chave = desembrulharChave(call.chaveCifrada, chaveMestra(mestra), call.id);
      const t = trechoCifrado(inicio, fim, total);
      const cifrado = await graph.baixar(call.spDriveId, call.spItemId, { range: `bytes=${t.de}-${t.ate}` });
      if (!cifrado.ok || !cifrado.body) return new Response(null, { status: cifrado.status === 404 ? 404 : 502 });
      const out = new Headers({ ...cabecalhos("m4a"), "Content-Length": String(fim - inicio + 1) });
      if (faixa) out.set("Content-Range", `bytes ${inicio}-${fim}/${total}`);
      return new Response(decifrarTrecho(cifrado.body, chave, total, inicio, fim), { status: faixa ? 206 : 200, headers: out });
    }
    const headers: Record<string, string> = {}; if (range) headers.Range = range;
    const response = await servicoChamadas(`/internal/recordings/${call.numberId}/${call.ownerPersonId}/${call.recordingId}`, { headers });
    if (!response.ok) return new Response(null, { status: response.status === 404 ? 404 : 502 });
    const out = new Headers(cabecalhos("wav"));
    for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) { const value = response.headers.get(name); if (value) out.set(name, value); }
    return new Response(response.body, { status: response.status, headers: out });
  } catch { return new Response(null, { status: 503 }); }
} } } });
