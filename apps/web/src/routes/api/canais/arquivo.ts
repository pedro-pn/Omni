import { randomUUID } from "node:crypto";

import { schema, withPerson } from "@omni/db";
import { GraphError } from "@omni/integrations/graph";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../../../server/db.ts";
import { getEnv } from "../../../server/env.ts";
import { getGraph } from "../../../server/graph.ts";
import { isSameOrigin } from "../../../server/http.ts";
import { personIdFromRequest } from "../../../server/session.ts";

/**
 * Arquivos no Interno e no Gerencial (0063): o navegador manda a mensagem com os
 * arquivos; o servidor confere o acesso ao canal, envia ao SharePoint do Omni (site
 * OmniAnexos, Canais/<missão>/<id>.<extensão>, sem o nome do arquivo no caminho) e
 * grava a mensagem e os arquivos juntos. Se a gravação falhar, apaga o que subiu.
 */

const MAX_POR_ARQUIVO = 50 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const MAX_ARQUIVOS = 10;

const json = (corpo: unknown, status: number) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const nomeSeguro = (nome: string) => nome.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim().slice(0, 200) || "arquivo";
const extensao = (nome: string) => nome.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase() ?? "bin";

/** Pasta no SharePoint: "Canais" na produção, "Canais-<ambiente>" fora dela (como as gravações). */
function pastaDosCanais() {
  const env = getEnv();
  const ambiente = env.OMNI_AMBIENTE ?? (env.NODE_ENV === "production" ? "producao" : "desenvolvimento");
  return ambiente === "producao" ? "Canais" : `Canais-${ambiente}`;
}

export const Route = createFileRoute("/api/canais/arquivo")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return json({ erro: "Sessão expirada. Entre de novo." }, 401);
        if (!isSameOrigin(request)) return json({ erro: "Origem inválida." }, 403);
        if (Number(request.headers.get("content-length") ?? 0) > MAX_TOTAL + 256 * 1024) return json({ erro: "Arquivos grandes demais (até 100 MB por mensagem)." }, 413);
        const graph = getGraph();
        const driveId = getEnv().GRAPH_ANEXOS_DRIVE_ID;
        if (!graph || !driveId) return json({ erro: "O envio de arquivos ainda não foi configurado no Omni." }, 503);
        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return json({ erro: "Envio inválido." }, 400);
        }
        const alvo = z
          .object({ missionId: z.uuid(), channel: z.enum(["interno", "gerencial"]), texto: z.string().max(8000).default("") })
          .safeParse({ missionId: form.get("missionId"), channel: form.get("channel"), texto: form.get("texto") ?? "" });
        const arquivos = form.getAll("arquivo").filter((a): a is File => a instanceof File && a.size > 0);
        if (!alvo.success || !arquivos.length) return json({ erro: "Envio inválido." }, 400);
        if (arquivos.length > MAX_ARQUIVOS) return json({ erro: `Até ${MAX_ARQUIVOS} arquivos por mensagem.` }, 400);
        if (arquivos.some((a) => a.size > MAX_POR_ARQUIVO)) return json({ erro: "Cada arquivo pode ter até 50 MB." }, 413);
        const { missionId, channel, texto } = alvo.data;
        // Só quem vê o canal (antes de subir qualquer coisa).
        const [acesso] = await withPerson(getPool(), personId, async (db) =>
          (await db.execute<{ ok: boolean }>(sql`SELECT app.canal_desde(${missionId}::uuid, ${channel}) IS NOT NULL AS ok`)).rows,
        );
        if (!acesso?.ok) return json({ erro: "Você não tem acesso a este canal." }, 403);
        const enviados: { id: string; name: string; mime: string; size: number; spItemId: string }[] = [];
        const desfazer = () => Promise.all(enviados.map((e) => graph.apagarDefinitivo(driveId, e.spItemId).catch(() => undefined)));
        try {
          for (const a of arquivos) {
            const id = randomUUID();
            const nome = nomeSeguro(a.name);
            const item = await graph.enviarArquivo(driveId, `${pastaDosCanais()}/${missionId}/${id}.${extensao(nome)}`, new Uint8Array(await a.arrayBuffer()));
            enviados.push({ id, name: nome, mime: (a.type || "application/octet-stream").split(";")[0]!.trim().toLowerCase().slice(0, 150), size: item.tamanho, spItemId: item.id });
          }
        } catch (error) {
          await desfazer();
          console.error("[canais] envio ao SharePoint falhou:", error instanceof GraphError ? error.status : (error as Error).name);
          return json({ erro: "Não foi possível guardar o arquivo agora. Tente de novo." }, 502);
        }
        try {
          // Mensagem e arquivos na mesma transação: o aviso de tempo real já encontra os arquivos.
          const id = await withPerson(getPool(), personId, async (db) => {
            const [m] = await db
              .insert(schema.missionMessages)
              .values({ missionId, channel, authorPersonId: personId, body: texto.trim() || enviados.map((e) => e.name).join(", ").slice(0, 8000) })
              .returning({ id: schema.missionMessages.id });
            await db.insert(schema.missionMessageFiles).values(enviados.map((e) => ({ id: e.id, messageId: m!.id, name: e.name, mime: e.mime, size: e.size, spDriveId: driveId, spItemId: e.spItemId })));
            return m!.id;
          });
          return json({ id }, 200);
        } catch (error) {
          await desfazer();
          console.error("[canais] mensagem com arquivo não gravou:", (error as Error).name);
          return json({ erro: "Não foi possível enviar a mensagem." }, 500);
        }
      },
    },
  },
});
