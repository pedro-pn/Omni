import { schema, type Db } from "@omni/db";
import { desc, sql } from "drizzle-orm";

export type Correspondente = {
  endereco: string;
  nome: string | null;
  ultimaEm: string;
  assunto: string | null;
  previa: string | null;
  naoLidos: number;
  total: number;
};

/**
 * Caixa única: com quem a pessoa trocou e-mails nos últimos `dias` (recebidos: remetente;
 * enviados: destinatários). Lê o resumo por correspondente (mail_correspondents, 0073),
 * mantido por gatilho a cada cabeçalho que entra, muda ou sai; só o dono lê (RLS).
 * Também usado pelo teste de carga.
 */
export async function lerCorrespondentes(db: Db, dias = 90): Promise<Correspondente[]> {
  const linhas = await db
    .select()
    .from(schema.mailCorrespondents)
    .where(sql`${schema.mailCorrespondents.lastAt} > now() - make_interval(days => ${dias})`)
    .orderBy(desc(schema.mailCorrespondents.lastAt))
    .limit(600);
  return linhas.map((l) => ({
    endereco: l.address,
    nome: l.name,
    ultimaEm: l.lastAt.toISOString(),
    assunto: l.lastSubject,
    previa: l.lastPreview,
    naoLidos: l.unread,
    total: l.total,
  }));
}
