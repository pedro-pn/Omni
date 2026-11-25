import { OpenAiClient, type Llm } from "@omni/integrations/openai";

import { getEnv } from "./env.ts";

let cliente: Llm | null | undefined;

/** LLM dos alertas pedidos à IA; `null` com IA_ALERTAS desligada ou sem chave. Só servidor. */
export function getLlmAlertas(): { llm: Llm; modelo: string } | null {
  const env = getEnv();
  if (cliente === undefined) cliente = env.IA_ALERTAS === "ligada" && env.OPENAI_API_KEY ? new OpenAiClient({ apiKey: env.OPENAI_API_KEY }) : null;
  return cliente ? { llm: cliente, modelo: env.OPENAI_MODEL } : null;
}
