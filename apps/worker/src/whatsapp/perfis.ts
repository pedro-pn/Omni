import { schema, type Db } from "@omni/db";
import { WhatsAppError, type WhatsApp } from "@omni/integrations/whatsapp";
import { eq, sql } from "drizzle-orm";

/**
 * Nome dos grupos, nome dos contatos e foto das conversas pelas listas de
 * conversas e de contatos da Evolution (duas chamadas por número). Só atualiza conversas que já existem no Omni.
 * Como no WhatsApp Web: o grupo pega sempre o nome atual; o contato, o nome da agenda do
 * celular (lista de contatos) sempre — menos quando o dono deu um nome no Omni —, e o da
 * lista de conversas só se ainda não tiver nome. Número no lugar de nome, nunca (0069).
 * Com o patch-lid, cada contato traz também o @lid (ou o número): a conversa que chegou
 * só pelo @lid ganha o número e o nome da agenda.
 * A foto não é baixada: guarda-se o endereço no WhatsApp, lido pelo servidor
 * do Omni quando alguém que vê o número abre a lista (/api/whatsapp/foto).
 */
export type ResultadoPerfis = { numeros: number; atualizadas: number; erros: number };

export async function atualizarPerfis(db: Db, fonte: Pick<WhatsApp, "conversas" | "contatos">): Promise<ResultadoPerfis> {
  const r: ResultadoPerfis = { numeros: 0, atualizadas: 0, erros: 0 };
  const numeros = await db.select().from(schema.whatsappNumbers).where(eq(schema.whatsappNumbers.status, "conectado"));
  for (const n of numeros) {
    r.numeros += 1;
    let lista;
    try {
      const [conversas, contatos] = await Promise.all([fonte.conversas(n.instanceName), fonte.contatos(n.instanceName)]);
      // Contatos (agenda) por último: prevalecem sobre o nome da lista de conversas.
      lista = [
        ...conversas.map((c) => ({ jid: c.jid, nome: c.nome, foto: c.foto, agenda: false, telefone: null as string | null })),
        ...contatos.flatMap((c) => {
          const numero = c.jid.endsWith("@s.whatsapp.net") ? c.jid : c.outro?.endsWith("@s.whatsapp.net") ? c.outro : null;
          const lid = c.jid.endsWith("@lid") ? c.jid : c.outro?.endsWith("@lid") ? c.outro : null;
          const telefone = numero ? numero.split("@")[0]! : null;
          return [
            ...(lid ? [{ jid: lid, nome: c.nome, foto: c.foto, agenda: true, telefone }] : []),
            ...(numero ? [{ jid: numero, nome: c.nome, foto: c.foto, agenda: true, telefone: null }] : []),
          ];
        }),
      ];
    } catch (error) {
      if (!(error instanceof WhatsAppError)) throw error;
      r.erros += 1;
      continue;
    }
    for (const c of lista) {
      if (!c.nome && !c.foto && !c.telefone) continue;
      const [x] = (
        await db.execute<{ mudou: boolean | null }>(
          sql`SELECT app.whatsapp_perfil_conversa(${n.id}::uuid, ${c.jid}, ${c.nome}, ${c.foto}, ${c.agenda}, ${c.telefone}) AS mudou`,
        )
      ).rows;
      if (x?.mudou) r.atualizadas += 1;
    }
  }
  return r;
}
