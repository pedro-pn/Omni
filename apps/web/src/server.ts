import { createServerEntry, createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

import { cabecalhoCsp, comNonce, novoNonce, PERMISSIONS_POLICY, politicaCsp } from "./server/csp.ts";
import { capturarErrosDoProcesso, localDaRequisicao, registrarErroDoWeb } from "./server/erros.ts";
import { limitarRequisicao } from "./server/limites.ts";

/**
 * Entrada do servidor (a padrão do TanStack Start, mais):
 * - limite de requisições (E10): 429 antes de qualquer trabalho;
 * - cabeçalhos de segurança (E12): CSP com o nonce desta requisição nas páginas e
 *   Permissions-Policy em tudo (apps/web/src/server/csp.ts);
 * - registro de erros (E09): requisição que lança ou termina em 5xx vira erro do sistema. As
 *   server functions já registram com o nome da função no middleware de start.ts.
 */
const handler = createStartHandler(defaultStreamHandler);
capturarErrosDoProcesso();

const modoCsp = () => (process.env.CSP_MODO === "aplicar" ? "aplicar" : "relatorio");

function comCabecalhos(resposta: Response, nonce: string): Response {
  const headers = new Headers(resposta.headers);
  headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  // Rotas de arquivo que já trazem a própria CSP (sandbox) ficam com a delas.
  if ((headers.get("content-type") ?? "").includes("text/html") && !headers.has("Content-Security-Policy")) {
    headers.set(cabecalhoCsp(modoCsp()), politicaCsp(nonce));
  }
  return new Response(resposta.body, { status: resposta.status, statusText: resposta.statusText, headers });
}

export default createServerEntry({
  async fetch(request, opts) {
    const recusa = limitarRequisicao(request);
    if (recusa) return recusa;
    const nonce = novoNonce();
    try {
      const resposta = await comNonce(nonce, async () => handler(request, opts));
      if (resposta.status >= 500 && !new URL(request.url).pathname.startsWith("/_serverFn")) {
        const erro = Object.assign(new Error(`Resposta ${resposta.status}`), { name: `HTTP ${resposta.status}`, stack: undefined });
        void registrarErroDoWeb(erro, localDaRequisicao(request));
      }
      return comCabecalhos(resposta, nonce);
    } catch (erro) {
      await registrarErroDoWeb(erro, localDaRequisicao(request));
      throw erro;
    }
  },
});
