import { avaliarGastoIa, type TetoDaIa } from "@omni/core";
import { type Db } from "@omni/db";
import { comTeto, OpenAiClient, TetoDiarioAtingido, type Llm, type Transcritor } from "@omni/integrations/openai";
import { sql } from "drizzle-orm";

/**
 * Teto diário da IA no worker (E11, pilar 10.2; migration 0080). Antes de cada chamada, soma o gasto
 * do dia (`app.gasto_ia_hoje`) e compara com o teto: com metade, registra um erro do sistema (aviso a
 * quem administra, no máximo a cada 6 h); no teto, registra e recusa a chamada com TetoDiarioAtingido,
 * que cada job trata como falha da IA (llm_calls com error_code = teto_diario) e segue.
 */
export function conferidorDoTeto(db: Db, teto: TetoDaIa): () => Promise<void> {
  return async () => {
    const [uso] = (await db.execute<{ tokens: string; chamadas: string }>(sql`SELECT tokens, chamadas FROM app.gasto_ia_hoje()`)).rows;
    const r = avaliarGastoIa({ tokens: Number(uso?.tokens ?? 0), chamadas: Number(uso?.chamadas ?? 0) }, teto);
    if (r.situacao === "ok") return;
    const chave = r.situacao === "teto" ? "ia:teto" : "ia:metade";
    await db
      .execute(sql`SELECT app.registrar_erro(${`operacao|${chave}`}, 'operacao', ${chave}, ${r.mensagem}, NULL, 'ia', ${(process.env.OMNI_VERSAO || "").slice(0, 12) || null})`)
      .catch((e: Error) => console.error("[teto-ia] não foi possível registrar:", e.message));
    if (r.situacao === "teto") throw new TetoDiarioAtingido(r.mensagem);
  };
}

/** Cliente da OpenAI com o teto diário (todo LLM do worker sai por aqui). */
export function openAiComTeto(apiKey: string, conferir: () => Promise<void>): Llm & Transcritor {
  return comTeto(new OpenAiClient({ apiKey }), conferir);
}
