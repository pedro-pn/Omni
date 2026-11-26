import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DE_SERVIDOR } from "./csrf.ts";
import { ROTAS_PUBLICAS } from "./rotas-publicas.ts";

const PASTA_ROTAS = join(import.meta.dirname, "..", "routes");
const CADDY = join(import.meta.dirname, "..", "..", "..", "..", "deploy", "caddy", "omni.caddy");
const OPENAPI = join(import.meta.dirname, "..", "..", "public", "openapi.json");

function arquivos(pasta: string): string[] {
  return readdirSync(pasta, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? arquivos(join(pasta, e.name)) : /\.tsx?$/.test(e.name) && !e.name.includes(".test.") ? [join(pasta, e.name)] : [],
  );
}

/** Rotas de servidor (com `server: { handlers }`), com o caminho e se conferem a sessão. */
const rotasDeServidor = arquivos(PASTA_ROTAS)
  .map((arquivo) => ({ arquivo, texto: readFileSync(arquivo, "utf8") }))
  .filter(({ texto }) => /server:\s*\{\s*handlers/.test(texto))
  .map(({ arquivo, texto }) => ({
    arquivo,
    caminho: texto.match(/createFileRoute\("([^"]+)"\)/)?.[1] ?? "?",
    comSessao: texto.includes("personIdFromRequest("),
    metodos: [...texto.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s*[:(]/g)].map((m) => m[1]!),
  }));

describe("rotas públicas (E14)", () => {
  it("toda rota sem sessão está na lista, e toda rota da lista existe e não pede sessão", () => {
    const semSessao = rotasDeServidor.filter((r) => !r.comSessao).map((r) => r.caminho).sort();
    expect(semSessao).toEqual(ROTAS_PUBLICAS.map((r) => r.caminho).sort());
  });

  it("os métodos da lista são os que a rota atende", () => {
    for (const p of ROTAS_PUBLICAS) {
      const rota = rotasDeServidor.find((r) => r.caminho === p.caminho)!;
      expect(new Set(rota.metodos), p.caminho).toEqual(new Set(p.metodos));
    }
  });

  it("só rota pública fica fora da conferência de origem (nenhuma rota com sessão escapa do CSRF)", () => {
    for (const prefixo of DE_SERVIDOR) {
      const casadas = rotasDeServidor.filter((r) => r.caminho === prefixo || r.caminho.startsWith(prefixo));
      expect(casadas.length, prefixo).toBeGreaterThan(0);
      for (const r of casadas) expect(r.comSessao, `${r.caminho} tem sessão e está em DE_SERVIDOR`).toBe(false);
    }
  });

  it("as rotas internas ficam fechadas no Caddy, na produção e no staging", () => {
    const caddy = readFileSync(CADDY, "utf8");
    const internas = ROTAS_PUBLICAS.filter((r) => r.exposicao === "interna").map((r) => r.caminho);
    expect(internas.length).toBeGreaterThan(0);
    for (const bloco of ["omni.filtrovali.com.br {", "omnistaging.filtrovali.com.br {"]) {
      const trecho = caddy.slice(caddy.indexOf(bloco), caddy.indexOf("\n}\n", caddy.indexOf(bloco)));
      const fechadas = trecho.match(/@interno path ([^\n]+)/)?.[1]?.split(/\s+/) ?? [];
      expect(new Set(fechadas), bloco).toEqual(new Set(internas));
      expect(trecho).toMatch(/handle @interno \{\s*respond 404\s*\}/);
    }
  });

  it("o contrato OpenAPI traz a autorização do Prisma", () => {
    const contrato = JSON.parse(readFileSync(OPENAPI, "utf8")) as { paths: Record<string, { post?: { security?: unknown[] } }> };
    for (const c of ["/api/prisma-authorization/token", "/api/prisma-authorization/revoke"]) {
      expect(contrato.paths[c]?.post?.security, c).toEqual([]);
      expect(ROTAS_PUBLICAS.some((r) => r.caminho === c)).toBe(true);
    }
  });
});
