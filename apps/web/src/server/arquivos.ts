import { withPerson } from "@omni/db";
import { GraphError } from "@omni/integrations/graph";
import { sql } from "drizzle-orm";

import { ErroParaTela } from "../lib/erros.ts";
import { getPool } from "./db.ts";

/** Só no servidor: autorização das pastas comerciais e mensagens dos erros do Graph. */

/** Referência que a pessoa pode abrir, pronta para o Graph; senão, erro para a tela. */
export async function pastaAutorizada(personId: string, pastaId: string) {
  const [p] = await withPerson(getPool(), personId, async (db) =>
    (
      await db.execute<{ drive_id: string | null; folder_id: string; status: string; web_url: string | null; rotulo: string }>(
        sql`SELECT * FROM app.pasta_para_leitura(${pastaId}::uuid)`,
      )
    ).rows,
  );
  if (!p) throw new ErroParaTela("Você não tem acesso a esta pasta.");
  if (p.status !== "ready" || !p.drive_id) {
    throw new ErroParaTela("A biblioteca do SharePoint desta pasta ainda não foi configurada no Prisma.");
  }
  return { driveId: p.drive_id, folderId: p.folder_id, webUrl: p.web_url, rotulo: p.rotulo };
}

/** Erros do Graph em mensagens claras (sem detalhes técnicos). */
export function erroDoGraph(error: unknown): never {
  if (error instanceof GraphError) {
    if (error.status === 404) throw new ErroParaTela("Pasta ou arquivo não encontrado no SharePoint: pode ter sido removido ou movido. Peça para conferir o vínculo no Prisma.");
    if (error.status === 403) throw new ErroParaTela("O Omni ainda não tem permissão de leitura neste site do SharePoint.");
    if (error.status === 401 || error.code === "invalid_client") throw new ErroParaTela("A conexão do Omni com o Microsoft 365 não está ativa. Avise a administração.");
  }
  throw error;
}

