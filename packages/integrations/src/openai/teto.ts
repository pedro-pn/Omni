import { LlmError, type Llm, type RespostaLlm, type Transcritor } from "./client.ts";

/**
 * Teto diário de gasto da IA (E11): envoltório de qualquer cliente que, antes de cada chamada,
 * roda `conferir` (soma do dia em llm_calls contra o teto). Quem chama trata como qualquer
 * LlmError: registra a chamada como erro (`error_code = teto_diario`) e segue sem a IA.
 */
export class TetoDiarioAtingido extends LlmError {
  constructor(mensagem: string) {
    super(mensagem, 429, "teto_diario");
    this.name = "TetoDiarioAtingido";
  }
}

export function comTeto<C extends Partial<Llm & Transcritor>>(cliente: C, conferir: () => Promise<void>): Llm & Transcritor {
  return {
    async estruturado<T>(p: Parameters<Llm["estruturado"]>[0]): Promise<RespostaLlm<T>> {
      if (!cliente.estruturado) throw new LlmError("Este cliente não faz respostas estruturadas", 500);
      await conferir();
      return cliente.estruturado<T>(p);
    },
    async transcrever(p: Parameters<Transcritor["transcrever"]>[0]) {
      if (!cliente.transcrever) throw new LlmError("Este cliente não transcreve áudio", 500);
      await conferir();
      return cliente.transcrever(p);
    },
  };
}
