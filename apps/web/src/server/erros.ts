import { normalizarCaminho, resumirErro } from "@omni/core";

import { getPool } from "./db.ts";

/**
 * Erros do sistema no web (E09, pilar 12.1; migration 0079): server function que falhou sem ser
 * erro para a tela, requisição que terminou em 5xx e erro do processo. Grava já limpo
 * (`resumirErro`: sem e-mail, CPF, telefone, token nem query string) por `app.registrar_erro`;
 * o worker avisa quem administra (job `alertas-erros`). Nunca lança: registrar não pode
 * piorar a falha que está sendo registrada.
 */
export async function registrarErroDoWeb(erro: unknown, local: string): Promise<void> {
  const r = resumirErro(erro, "web", local);
  const versao = (process.env.OMNI_VERSAO || "").slice(0, 12) || null;
  try {
    await getPool().query("SELECT app.registrar_erro($1, $2, $3, $4, $5, $6, $7)", [r.assinatura, r.origem, r.nome, r.mensagem, r.detalhe, r.local, versao]);
  } catch (falha) {
    console.error("[erros] não foi possível registrar:", (falha as Error).message);
  }
}

/** Local de uma requisição para agrupar: método e caminho sem ids, tokens nem query string. */
export function localDaRequisicao(request: Request): string {
  let caminho = "/";
  try {
    caminho = new URL(request.url).pathname;
  } catch {
    // URL inválida: fica a raiz.
  }
  return `${request.method} ${normalizarCaminho(caminho)}`;
}

let instalado = false;
/** Promessas sem tratamento e exceções do processo do servidor (uma vez por processo). */
export function capturarErrosDoProcesso(): void {
  if (instalado) return;
  instalado = true;
  process.on("unhandledRejection", (motivo) => {
    console.error("[servidor] promessa rejeitada sem tratamento:", (motivo as Error)?.message ?? motivo);
    void registrarErroDoWeb(motivo, "processo");
  });
  process.on("uncaughtException", (erro) => {
    console.error("[servidor] exceção não tratada:", erro.message);
    void registrarErroDoWeb(erro, "processo").finally(() => process.exit(1));
  });
}
