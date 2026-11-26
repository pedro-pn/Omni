import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Página de manutenção (E24): o Caddy responde 503 com uma página própria quando o web não responde
 * (publicação, volta de versão, queda ou deploy/manutencao.sh on). Ela precisa se bastar, porque o
 * Omni está fora: nada carregado de fora, nenhum script.
 */
const RAIZ = join(import.meta.dirname, "..", "..", "..", "..");
const CADDY = readFileSync(join(RAIZ, "deploy", "caddy", "omni.caddy"), "utf8");
const trechoDe = (inicio: string) => CADDY.slice(CADDY.indexOf(inicio), CADDY.indexOf("\n}\n", CADDY.indexOf(inicio)));
const SNIPPET = trechoDe("(omni_manutencao) {");
const HTML = SNIPPET.slice(SNIPPET.indexOf("<<HTML") + 6, SNIPPET.lastIndexOf("HTML 503"));

describe("página de manutenção no Caddy", () => {
  it("produção e staging usam o mesmo trecho", () => {
    for (const bloco of ["omni.filtrovali.com.br {", "omnistaging.filtrovali.com.br {"]) {
      expect(trechoDe(bloco), bloco).toMatch(/\n\timport omni_manutencao\n/);
    }
  });

  it("responde só a 502, 503 e 504, separando API e página", () => {
    // No Caddy 2.8, `handle_errors 502 503 504` descarta os matchers de dentro (a página virava JSON).
    expect(SNIPPET).toMatch(/handle_errors \{/);
    expect(SNIPPET).toContain("@omni_api expression `{err.status_code} in [502, 503, 504] && path('/api/*')`");
    expect(SNIPPET).toContain("@omni_pagina expression `{err.status_code} in [502, 503, 504] && !path('/api/*')`");
    const json = SNIPPET.match(/respond `([^`]+)` 503/)?.[1];
    expect(JSON.parse(json!)).toMatchObject({ erro: "manutencao" });
    expect(SNIPPET.match(/header Retry-After 30/g)).toHaveLength(2);
    expect(SNIPPET.match(/header Cache-Control no-store/g)).toHaveLength(2);
  });

  it("a página se basta: português, sem script e nada de fora", () => {
    expect(HTML).toContain('<html lang="pt-BR">');
    expect(HTML).toContain('<meta charset="utf-8">');
    expect(HTML).toContain('<meta http-equiv="refresh" content="30">');
    expect(HTML).not.toMatch(/<script|<link|@import/i);
    expect(HTML).not.toMatch(/(src|href)\s*=\s*"(https?:)?\/\//i);
    expect(HTML).not.toMatch(/url\(/i);
    expect(HTML).toMatch(/src="data:image\/png;base64,/);
    // A linha "}" no começo cortaria o bloco do Caddy: o conteúdo fica recuado.
    expect(HTML).not.toMatch(/\n\}\n/);
  });

  it("manutencao.sh e publicar.sh usam o mesmo sinal", () => {
    const sinal = 'SINAL="${HOME}/omni-manutencao-${AMBIENTE}"';
    expect(readFileSync(join(RAIZ, "deploy", "manutencao.sh"), "utf8")).toContain(sinal);
    const publicar = readFileSync(join(RAIZ, "deploy", "publicar.sh"), "utf8");
    expect(publicar).toContain(sinal);
    expect(publicar).toContain("--encerrar-manutencao");
  });
});
