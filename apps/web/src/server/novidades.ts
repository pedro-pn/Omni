import type { Db } from "@omni/db";
import { sql } from "drizzle-orm";

/**
 * Caixa única: missões com mensagens não lidas, separando as de pessoas das da IA e
 * do sistema. A missão fica na lista pela hora da última mensagem DE PESSOA: aviso
 * da IA conta como não lido, mas não faz a missão subir.
 */
export type NovidadeDaMissao = {
  missionId: string;
  dePessoas: number;
  daIa: number;
  ultimaDePessoaEm: string | null;
  previa: string | null;
};

export async function lerNovidadesDasMissoes(db: Db): Promise<NovidadeDaMissao[]> {
  // Por canal, com o acesso calculado uma vez por canal (app.novidades_dos_canais, 0072).
  const { rows } = await db.execute<{ mission_id: string; de_pessoas: number; da_ia: number; ultima_de_pessoa: string | Date | null; previa: string | null }>(sql`
    SELECT mission_id, de_pessoas, da_ia, ultima_de_pessoa, previa FROM app.novidades_dos_canais()`);
  const porMissao = new Map<string, NovidadeDaMissao>();
  for (const r of rows) {
    const em = r.ultima_de_pessoa ? new Date(r.ultima_de_pessoa).toISOString() : null;
    const atual = porMissao.get(r.mission_id);
    if (!atual) {
      porMissao.set(r.mission_id, { missionId: r.mission_id, dePessoas: r.de_pessoas, daIa: r.da_ia, ultimaDePessoaEm: em, previa: r.previa });
      continue;
    }
    atual.dePessoas += r.de_pessoas;
    atual.daIa += r.da_ia;
    if (em && (!atual.ultimaDePessoaEm || em > atual.ultimaDePessoaEm)) {
      atual.ultimaDePessoaEm = em;
      atual.previa = r.previa;
    }
  }
  return [...porMissao.values()];
}
