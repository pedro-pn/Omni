import { schema, type Db } from "@omni/db";
import { WhatsAppError, type WhatsApp } from "@omni/integrations/whatsapp";
import { eq, ne } from "drizzle-orm";

/**
 * Confere na Evolution o estado de cada número do Omni (a cada 5 min). O
 * webhook avisa as mudanças na hora; isto cobre o que se perdeu (Omni fora do
 * ar, aparelho desconectado pelo celular). Não pareia nem desconecta nada.
 */

export type ResultadoEstado = { numeros: number; mudaram: number; erros: number };

const STATUS = { conectado: "conectado", conectando: "conectando", desconectado: "desconectado", inexistente: "desconectado" } as const;

export async function conferirNumeros(db: Db, whatsapp: Pick<WhatsApp, "estado">): Promise<ResultadoEstado> {
  const t = schema.whatsappNumbers;
  const r: ResultadoEstado = { numeros: 0, mudaram: 0, erros: 0 };
  for (const n of await db.select().from(t).where(ne(t.status, "removido"))) {
    r.numeros += 1;
    let atual;
    try {
      atual = await whatsapp.estado(n.instanceName);
    } catch (error) {
      if (!(error instanceof WhatsAppError)) throw error;
      r.erros += 1;
      // Evolution fora do ar ou chave recusada: vale para todos; tenta na próxima rodada.
      break;
    }
    // "criado" continua até a primeira tentativa de parear.
    const status = n.status === "criado" && atual.estado !== "conectado" ? "criado" : STATUS[atual.estado];
    const erro = atual.estado === "inexistente" ? 'O número sumiu da Evolution. Use "Reconfigurar" e pareie de novo.' : status === n.status ? n.lastError : null;
    const telefone = atual.telefone ?? n.phone;
    if (status === n.status && telefone === n.phone && erro === n.lastError) continue;
    try {
      await db.update(t).set({ status, statusAt: status === n.status ? n.statusAt : new Date(), phone: telefone, lastError: erro }).where(eq(t.id, n.id));
    } catch {
      // Telefone já em outro número ativo: avisa sem trocar o telefone.
      await db
        .update(t)
        .set({ status, statusAt: new Date(), lastError: "Este aparelho já está pareado em outro número do Omni. Desconecte um dos dois." })
        .where(eq(t.id, n.id));
    }
    r.mudaram += 1;
  }
  return r;
}
