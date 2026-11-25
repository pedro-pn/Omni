import { createServerEntry, createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

import { capturarErrosDoProcesso, localDaRequisicao, registrarErroDoWeb } from "./server/erros.ts";

/**
 * Entrada do servidor (a padrão do TanStack Start, com o registro de erros da E09): toda requisição
 * que lança ou termina em 5xx — rotas /api, páginas e server functions — vira erro do sistema.
 * As server functions já registram com o nome da função no middleware de start.ts; aqui ficam as
 * rotas e o que escapa de tudo.
 */
const handler = createStartHandler(defaultStreamHandler);
capturarErrosDoProcesso();

export default createServerEntry({
  async fetch(request, opts) {
    try {
      const resposta = await handler(request, opts);
      if (resposta.status >= 500 && !new URL(request.url).pathname.startsWith("/_serverFn")) {
        const erro = Object.assign(new Error(`Resposta ${resposta.status}`), { name: `HTTP ${resposta.status}`, stack: undefined });
        void registrarErroDoWeb(erro, localDaRequisicao(request));
      }
      return resposta;
    } catch (erro) {
      await registrarErroDoWeb(erro, localDaRequisicao(request));
      throw erro;
    }
  },
});
