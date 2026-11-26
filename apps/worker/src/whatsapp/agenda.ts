import { schema, type Db } from "@omni/db";
import type { ContatoSalvo, DiagnosticoDaAgenda } from "@omni/integrations/whatsapp";
import { and, eq, isNotNull, sql } from "drizzle-orm";

/**
 * Agenda do celular de cada número conectado (job whatsapp-agenda, 6 h): pela ponte de ações da
 * Evolution, só os contatos SALVOS com o nome salvo (não o nome de perfil). Com ela, o Omni mostra
 * o nome só de quem está salvo — os outros aparecem pelo número, como no WhatsApp Web (0088).
 */
export type ResultadoAgenda = {
  numeros: number;
  contatos: number;
  erros: number;
  vazias: number;
  /** Listas parciais (a coleção não baixou e não houve histórico): só acrescentadas, sem apagar nem marcar a leitura. */
  parciais: number;
  diagnosticos: Array<{ diagnostico: DiagnosticoDaAgenda | null; mensagens: string[] }>;
};

export async function lerAgendas(
  db: Db,
  ponte: { contatos(telefone: string): Promise<{ contatos: ContatoSalvo[]; completa: boolean; diagnostico: DiagnosticoDaAgenda | null; mensagens: string[] }> },
): Promise<ResultadoAgenda> {
  const r: ResultadoAgenda = { numeros: 0, contatos: 0, erros: 0, vazias: 0, parciais: 0, diagnosticos: [] };
  const numeros = await db
    .select({ id: schema.whatsappNumbers.id, telefone: schema.whatsappNumbers.phone })
    .from(schema.whatsappNumbers)
    .where(and(eq(schema.whatsappNumbers.status, "conectado"), isNotNull(schema.whatsappNumbers.phone)));
  for (const n of numeros) {
    r.numeros += 1;
    try {
      const { contatos, completa, diagnostico, mensagens } = await ponte.contatos(n.telefone!);
      r.diagnosticos.push({ diagnostico, mensagens });
      // Agenda vazia: leitura que não veio (ou conta sem contatos na agenda do WhatsApp). Não
      // grava nem marca como lida — senão toda conversa passaria a aparecer só pelo número.
      if (!contatos.length) {
        r.vazias += 1;
        continue;
      }
      // Parcial (ex.: só o contato adicionado pelo Omni depois de reiniciar a Evolution): acrescenta
      // sem apagar o resto e sem marcar a leitura.
      if (!completa) {
        r.parciais += 1;
        for (const c of contatos) {
          const telefone = (c.telefone ?? (c.jid.endsWith("@s.whatsapp.net") ? c.jid : "")).replace(/\D/g, "");
          await db
            .insert(schema.whatsappContacts)
            .values({ numberId: n.id, jid: c.jid, lid: c.lid, phone: /^\d{8,15}$/.test(telefone) ? telefone : null, savedName: c.nome })
            .onConflictDoUpdate({ target: [schema.whatsappContacts.numberId, schema.whatsappContacts.jid], set: { savedName: c.nome, updatedAt: new Date() } });
        }
        r.contatos += contatos.length;
        continue;
      }
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
