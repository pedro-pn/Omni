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
import { exigirModulo } from "../../../server/modulos.ts";
import { personIdFromRequest } from "../../../server/session.ts";

/**
 * Anexar arquivos a uma tarefa (0077): o servidor confere que a pessoa vê a tarefa, envia
 * ao SharePoint do Omni (site OmniAnexos, Tarefas/<tarefa>/<id>.<extensão>, sem o nome do
 * arquivo no caminho) e grava os anexos. Se a gravação falhar, apaga o que subiu.
 */

const MAX_POR_ARQUIVO = 50 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const MAX_ARQUIVOS = 10;

const json = (corpo: unknown, status: number) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
export const nomeSeguro = (nome: string) => nome.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim().slice(0, 200) || "arquivo";
export const extensao = (nome: string) => nome.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase() ?? "bin";

/** Pasta no SharePoint: "Tarefas" na produção, "Tarefas-<ambiente>" fora dela (como os canais). */
function pastaDasTarefas() {
  const env = getEnv();
  const ambiente = env.OMNI_AMBIENTE ?? (env.NODE_ENV === "production" ? "producao" : "desenvolvimento");
  return ambiente === "producao" ? "Tarefas" : `Tarefas-${ambiente}`;
}

export const Route = createFileRoute("/api/tarefas/anexo")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const personId = await personIdFromRequest(request);
        if (!personId) return json({ erro: "Sessão expirada. Entre de novo." }, 401);
        if (!isSameOrigin(request)) return json({ erro: "Origem inválida." }, 403);
        try {
          await exigirModulo(personId, "tarefas");
        } catch {
          return json({ erro: "As tarefas não estão liberadas para você." }, 403);
        }
        if (Number(request.headers.get("content-length") ?? 0) > MAX_TOTAL + 256 * 1024) return json({ erro: "Arquivos grandes demais (até 100 MB por vez)." }, 413);
        const graph = getGraph();
        const driveId = getEnv().GRAPH_ANEXOS_DRIVE_ID;
        if (!graph || !driveId) return json({ erro: "O envio de arquivos ainda não foi configurado no Omni." }, 503);
        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return json({ erro: "Envio inválido." }, 400);
        }
        const tarefa = z.uuid().safeParse(form.get("taskId"));
        const arquivos = form.getAll("arquivo").filter((a): a is File => a instanceof File && a.size > 0);
        if (!tarefa.success || !arquivos.length) return json({ erro: "Envio inválido." }, 400);
        if (arquivos.length > MAX_ARQUIVOS) return json({ erro: `Até ${MAX_ARQUIVOS} arquivos por vez.` }, 400);
        if (arquivos.some((a) => a.size > MAX_POR_ARQUIVO)) return json({ erro: "Cada arquivo pode ter até 50 MB." }, 413);
        const taskId = tarefa.data;
        // Só quem vê a tarefa (antes de subir qualquer coisa).
        const [acesso] = await withPerson(getPool(), personId, async (db) => (await db.execute<{ ok: boolean }>(sql`SELECT app.pode_ver_tarefa(${taskId}::uuid) AS ok`)).rows);
        if (!acesso?.ok) return json({ erro: "Você não tem acesso a esta tarefa." }, 403);
        const enviados: { id: string; name: string; mime: string; size: number; spItemId: string }[] = [];
        const desfazer = () => Promise.all(enviados.map((e) => graph.apagarDefinitivo(driveId, e.spItemId).catch(() => undefined)));
        try {
          for (const a of arquivos) {
            const id = randomUUID();
            const nome = nomeSeguro(a.name);
            const item = await graph.enviarArquivo(driveId, `${pastaDasTarefas()}/${taskId}/${id}.${extensao(nome)}`, new Uint8Array(await a.arrayBuffer()));
            enviados.push({ id, name: nome, mime: (a.type || "application/octet-stream").split(";")[0]!.trim().toLowerCase().slice(0, 150), size: item.tamanho, spItemId: item.id });
          }
        } catch (error) {
          await desfazer();
          console.error("[tarefas] envio ao SharePoint falhou:", error instanceof GraphError ? error.status : (error as Error).name);
          return json({ erro: "Não foi possível guardar o arquivo agora. Tente de novo." }, 502);
        }
        try {
          await withPerson(getPool(), personId, (db) =>
            db.insert(schema.taskAttachments).values(enviados.map((e) => ({ id: e.id, taskId, name: e.name, mime: e.mime, size: e.size, spDriveId: driveId, spItemId: e.spItemId, uploadedBy: personId }))),
          );
          return json({ ids: enviados.map((e) => e.id) }, 200);
        } catch (error) {
          await desfazer();
          console.error("[tarefas] anexo não gravou:", (error as Error).name);
          return json({ erro: "Não foi possível anexar o arquivo." }, 500);
        }
      },
    },
  },
});
