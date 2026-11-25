import type { Db } from "@omni/db";
import { GraphError, type GraphClient, type UsuarioEntra } from "@omni/integrations/graph";
import { sql } from "drizzle-orm";

/**
 * Pessoas pelo Entra (0049): quem está em "Usuários e grupos" do app "Omni"
 * (direto ou por grupo, com a conta ativa) entra na lista de Pessoas antes do
 * primeiro login, para a Administração definir perfis e funções. Quem sai do app
 * (ou tem a conta desativada) é desativado no Omni; voltando, é reativado.
 * Convidados (contas de fora) ficam de fora. Se alguma parte da lista não pôde ser
 * lida, ninguém é desativado nesta rodada.
 */
export type FonteEntra = Pick<GraphClient, "atribuidosAoApp" | "pessoasDoGrupo" | "usuarioEntra">;
export type ResultadoPessoasEntra = {
  atribuicoes: number;
  pessoas: number;
  criadas: number;
  atualizadas: number;
  reativadas: number;
  conflitos: number;
  ignoradas: number;
  desativadas: number;
  /** Leitura incompleta (ex.: sem GroupMember.Read.All): nada foi desativado. */
  parcial: boolean;
  erro: string | null;
};

const motivo = (e: unknown) => (e instanceof GraphError ? `${e.status}${e.code ? ` ${e.code}` : ""}` : "erro");

export async function sincronizarPessoasDoEntra(db: Db, fonte: FonteEntra, appId: string): Promise<ResultadoPessoasEntra> {
  const r: ResultadoPessoasEntra = { atribuicoes: 0, pessoas: 0, criadas: 0, atualizadas: 0, reativadas: 0, conflitos: 0, ignoradas: 0, desativadas: 0, parcial: false, erro: null };
  let atribuicoes;
  try {
    atribuicoes = await fonte.atribuidosAoApp(appId);
  } catch (error) {
    if (!(error instanceof GraphError)) throw error;
    // 403: falta Application.Read.All no app "Omni – Integrações"; 404: id do app errado.
    r.erro = `atribuições do app: ${motivo(error)}`;
    return r;
  }
  r.atribuicoes = atribuicoes.length;
  const pessoas = new Map<string, UsuarioEntra>();
  for (const a of atribuicoes) {
    try {
      if (a.tipo === "usuario") {
        const u = await fonte.usuarioEntra(a.id);
        if (u) pessoas.set(u.id, u);
      } else {
        for (const u of await fonte.pessoasDoGrupo(a.id)) pessoas.set(u.id, u);
      }
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      r.parcial = true;
      r.erro = `${a.tipo === "grupo" ? "membros de um grupo" : "uma pessoa"}: ${motivo(error)}`;
    }
  }
  const atribuidas: string[] = [];
  for (const u of pessoas.values()) {
    if (!u.ativa || u.convidada || !u.email) {
      r.ignoradas += 1;
      continue;
    }
    const [linha] = (await db.execute<{ r: string }>(sql`SELECT app.entra_sincronizar_pessoa(${u.id}::uuid, ${u.email}, ${u.nome}) AS r`)).rows;
    atribuidas.push(u.id);
    if (linha?.r === "criada") r.criadas += 1;
    else if (linha?.r === "reativada") r.reativadas += 1;
    else if (linha?.r === "conflito") r.conflitos += 1;
    else if (linha?.r === "atualizada") r.atualizadas += 1;
  }
  r.pessoas = atribuidas.length;
  // Só com a lista completa: um grupo que não pôde ser lido não desativa os membros dele.
  if (!r.parcial && atribuidas.length > 0) {
    const ids = sql.join(atribuidas.map((id) => sql`${id}::uuid`), sql`, `);
    const [d] = (await db.execute<{ n: number }>(sql`SELECT app.entra_encerrar_ausentes(ARRAY[${ids}]::uuid[]) AS n`)).rows;
    r.desativadas = Number(d?.n ?? 0);
  }
  return r;
}
