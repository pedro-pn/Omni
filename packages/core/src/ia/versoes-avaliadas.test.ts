import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ESQUEMA_LEITURA_RDO, SISTEMA_LEITURA_RDO, VERSAO_PROMPT_RDO } from "./rdo.ts";

/**
 * Trava das instruções da IA (Fase 8): o texto das instruções da leitura dos RDOs só muda
 * junto com a versão, e cada versão precisa ter passado pela avaliação
 * (`npm run ia:avaliar`, também no CI pelo workflow "Avaliação da IA").
 *
 * Mudou SISTEMA_LEITURA_RDO ou ESQUEMA_LEITURA_RDO?
 *   1. troque VERSAO_PROMPT_RDO;
 *   2. rode `npm run ia:avaliar` (ou o workflow) e confira o resultado;
 *   3. acrescente aqui a versão nova com o SHA-256 que este teste mostrar.
 */
const AVALIADAS: Record<string, string> = {
  "rdo-2026-11-05b": "4cb6835e0c9ce20bdd8731e736f10d9fed10f884b40109c71fa22656b730c4c2",
};

describe("instruções da IA avaliadas", () => {
  it("leitura dos RDOs: o texto atual é o da versão avaliada", () => {
    const atual = createHash("sha256").update(SISTEMA_LEITURA_RDO + JSON.stringify(ESQUEMA_LEITURA_RDO)).digest("hex");
    const esperado = AVALIADAS[VERSAO_PROMPT_RDO];
    expect(
      esperado,
      `A versão ${VERSAO_PROMPT_RDO} não está na lista de versões avaliadas. Rode \`npm run ia:avaliar\` e acrescente "${VERSAO_PROMPT_RDO}": "${atual}" em AVALIADAS.`,
    ).toBeDefined();
    expect(
      atual,
      `As instruções da leitura dos RDOs mudaram sem trocar VERSAO_PROMPT_RDO (${VERSAO_PROMPT_RDO}). Troque a versão, rode \`npm run ia:avaliar\` e registre o novo SHA-256: ${atual}`,
    ).toBe(esperado);
  });
});
