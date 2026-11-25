import { avaliarGastoIa } from "@omni/core";
import { comTeto, OpenAiClient, TetoDiarioAtingido, type Llm } from "@omni/integrations/openai";

import { getPool } from "./db.ts";
import { getEnv } from "./env.ts";

let cliente: Llm | null | undefined;

/**
 * LLM dos alertas pedidos à IA; `null` com IA_ALERTAS desligada ou sem chave. Só servidor.
 * Passa pelo teto diário da IA (E11): o gasto do dia é o mesmo do worker (`app.gasto_ia_hoje`).
 */
export function getLlmAlertas(): { llm: Llm; modelo: string } | null {
  const env = getEnv();
  if (cliente === undefined) {
    cliente =
      env.IA_ALERTAS === "ligada" && env.OPENAI_API_KEY
        ? comTeto(new OpenAiClient({ apiKey: env.OPENAI_API_KEY }), async () => {
            const { rows } = await getPool().query<{ tokens: string; chamadas: string }>("SELECT tokens, chamadas FROM app.gasto_ia_hoje()");
            const r = avaliarGastoIa({ tokens: Number(rows[0]?.tokens ?? 0), chamadas: Number(rows[0]?.chamadas ?? 0) }, { tokens: env.IA_TETO_TOKENS_DIA, chamadas: env.IA_TETO_CHAMADAS_DIA });
            if (r.situacao === "teto") throw new TetoDiarioAtingido(r.mensagem);
          })
        : null;
  }
  return cliente ? { llm: cliente, modelo: env.OPENAI_MODEL } : null;
}

/** Registra a chamada em llm_calls (só metadados, nunca o texto), para entrar no gasto do dia. */
export async function registrarChamadaLlm(c: { finalidade: string; modelo: string; tokensEntrada?: number; tokensSaida?: number; duracaoMs?: number; erro?: string }): Promise<void> {
  try {
    await getPool().query("SELECT app.registrar_chamada_llm($1, $2, $3, $4, $5, $6, $7)", [
      c.finalidade,
      c.modelo,
      c.tokensEntrada ?? 0,
      c.tokensSaida ?? 0,
      c.duracaoMs ?? null,
      c.erro ? "erro" : "ok",
      c.erro ?? null,
    ]);
  } catch (e) {
    console.error("[llm] não foi possível registrar a chamada:", (e as Error).message);
  }
}
