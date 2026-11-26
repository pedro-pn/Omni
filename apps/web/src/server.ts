import { createServerEntry, createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

import { cabecalhoCsp, comNonce, novoNonce, PERMISSIONS_POLICY, politicaCsp } from "./server/csp.ts";
import { conferirOrigem } from "./server/csrf.ts";
import { medirRequisicao } from "./server/desempenho.ts";
import { capturarErrosDoProcesso, localDaRequisicao, registrarErroDoWeb } from "./server/erros.ts";
import { limitarRequisicao } from "./server/limites.ts";

/**
 * Entrada do servidor (a padrão do TanStack Start, mais):
 * - limite de requisições (E10): 429 antes de qualquer trabalho;
 * - conferência de origem (E16): o que altera algo só vem da própria origem do Omni (403);
 * - cabeçalhos de segurança (E12): CSP com o nonce desta requisição nas páginas e
 *   Permissions-Policy em tudo (apps/web/src/server/csp.ts);
 * - registro de erros (E09): requisição que lança ou termina em 5xx vira erro do sistema. As
 *   server functions já registram com o nome da função no middleware de start.ts;
 * - tempo por rota (E19): até a resposta começar (o corpo em fluxo não entra), em server/desempenho.ts.
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

function recusarOutraOrigem(request: Request): Response | null {
  const appOrigin = process.env.APP_ORIGIN;
  if (!appOrigin) return null; // sem APP_ORIGIN o ambiente nem sobe (validação do env)
  const caminho = new URL(request.url).pathname;
  const v = conferirOrigem({
    metodo: request.method,
    caminho,
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    appOrigin,
  });
  if (v.ok) return null;
  // Tentativa vinda de outro site: fica registrada (sem a origem, que pode identificar alguém).
  const erro = Object.assign(new Error(`Requisição ${request.method} recusada: ${v.motivo}.`), { name: "OrigemRecusada", stack: undefined });
  void registrarErroDoWeb(erro, `origem ${localDaRequisicao(request)}`);
  return new Response(JSON.stringify({ error: "origem_invalida", mensagem: "Origem inválida." }), {
    status: 403,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default createServerEntry({
  async fetch(request, opts) {
    const recusa = limitarRequisicao(request);
    if (recusa) return recusa;
    const recusaOrigem = recusarOutraOrigem(request);
    if (recusaOrigem) return recusaOrigem;
    const nonce = novoNonce();
    const inicio = performance.now();
    const caminho = new URL(request.url).pathname;
    try {
      const resposta = await comNonce(nonce, async () => handler(request, opts));
      medirRequisicao(request.method, caminho, performance.now() - inicio, resposta.status);
      if (resposta.status >= 500 && !caminho.startsWith("/_serverFn")) {
        const erro = Object.assign(new Error(`Resposta ${resposta.status}`), { name: `HTTP ${resposta.status}`, stack: undefined });
        void registrarErroDoWeb(erro, localDaRequisicao(request));
      }
      return comCabecalhos(resposta, nonce);
    } catch (erro) {
      medirRequisicao(request.method, caminho, performance.now() - inicio, 500);
      await registrarErroDoWeb(erro, localDaRequisicao(request));
      throw erro;
    }
  },
});
