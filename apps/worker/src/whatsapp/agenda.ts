import { schema, type Db } from "@omni/db";
import type { ContatoSalvo } from "@omni/integrations/whatsapp";
import { and, eq, isNotNull, sql } from "drizzle-orm";

/**
 * Agenda do celular de cada número conectado (job whatsapp-agenda, 6 h): pela ponte de ações da
 * Evolution, só os contatos SALVOS com o nome salvo (não o nome de perfil). Com ela, o Omni mostra
 * o nome só de quem está salvo — os outros aparecem pelo número, como no WhatsApp Web (0088).
 */
export type ResultadoAgenda = { numeros: number; contatos: number; erros: number };

export async function lerAgendas(db: Db, ponte: { contatos(telefone: string): Promise<ContatoSalvo[]> }): Promise<ResultadoAgenda> {
  const r: ResultadoAgenda = { numeros: 0, contatos: 0, erros: 0 };
  const numeros = await db
    .select({ id: schema.whatsappNumbers.id, telefone: schema.whatsappNumbers.phone })
    .from(schema.whatsappNumbers)
    .where(and(eq(schema.whatsappNumbers.status, "conectado"), isNotNull(schema.whatsappNumbers.phone)));
  for (const n of numeros) {
    r.numeros += 1;
    try {
      const contatos = await ponte.contatos(n.telefone!);
      const [s] = (await db.execute<{ n: number }>(sql`SELECT app.whatsapp_salvar_agenda(${n.id}::uuid, ${JSON.stringify(contatos)}::jsonb) AS n`)).rows;
      r.contatos += Number(s?.n ?? 0);
    } catch (error) {
      // Linha fora do ar ou ponte desligada: a agenda anterior continua valendo.
      r.erros += 1;
      console.error("[whatsapp-agenda] número não lido:", (error as { code?: string }).code ?? (error as Error).name);
    }
  }
  return r;
}
