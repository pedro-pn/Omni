import { withPerson } from "@omni/db";
import { sql } from "drizzle-orm";

import { getPool } from "./db.ts";

/**
 * Registro dos downloads intencionais (Fase 11: alerta de download em massa). Vai para
 * audit_log como "arquivo.baixado" (origem e id, sem conteúdo nem nome do arquivo); o
 * job `riscos` do worker soma por pessoa. Pedido de um trecho que não é o começo
 * (player de áudio, Range) não conta de novo. Falha no registro não impede o download.
 */
export type OrigemDownload = "sharepoint" | "anexo_email_missao" | "anexo_minha_caixa" | "relatorio_pdf" | "gravacao" | "arquivo_canal" | "anexo_tarefa";

export async function registrarDownload(request: Request, personId: string, origem: OrigemDownload, id: string): Promise<void> {
  const range = request.headers.get("range");
  if (range && !/^bytes=0-/.test(range.trim())) return;
  try {
    await withPerson(getPool(), personId, (db) =>
      db.execute(sql`INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id) VALUES (${personId}::uuid, 'arquivo.baixado', ${origem}, ${id.slice(0, 300)})`),
    );
  } catch (error) {
    console.error("[downloads] registro falhou:", (error as Error).name);
  }
}
