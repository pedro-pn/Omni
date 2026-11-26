import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Mapa das variáveis (E22, pilar 13): docs/variaveis.md tem de listar toda variável que o código, os
 * modelos de .env e os compose leem, e nada que não exista mais. Variável nova: documente lá.
 */
const RAIZ = join(import.meta.dirname, "..", "..", "..", "..");
const ler = (p: string) => readFileSync(join(RAIZ, p), "utf8");

/** Variáveis do próprio GitHub Actions, fora do controle do Omni. */
const DE_FORA = new Set(["GITHUB_STEP_SUMMARY"]);

function arquivos(dir: string): string[] {
  const base = join(RAIZ, dir);
  if (!existsSync(base)) return [];
  return (readdirSync(base, { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/(^|\/)(node_modules|\.output|dist)\//.test(f) && !f.endsWith("routeTree.gen.ts"))
    .map((f) => join(dir, f));
}

function usadas(): Map<string, string> {
  const onde = new Map<string, string>();
  const anota = (nome: string, arq: string) => {
    if (!DE_FORA.has(nome) && !onde.has(nome)) onde.set(nome, arq);
  };
  const codigo = ["apps/web/src", "apps/web/scripts", "apps/worker/src", "packages/core/src", "packages/db/src", "packages/integrations/src", "e2e"].flatMap(arquivos);
  for (const arq of codigo) {
    for (const m of ler(arq).matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]+)|\[["']([A-Z][A-Z0-9_]+)["']\])/g)) anota((m[1] ?? m[2])!, arq);
  }
  for (const arq of ["apps/web/src/server/env.ts", "apps/worker/src/env.ts"]) {
    for (const m of ler(arq).matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)) anota(m[1]!, arq);
  }
  for (const arq of [".env.example", "deploy/production.env.example", "deploy/staging.env.example", "deploy/logs/logs.env.example", "e2e/ambiente.env"]) {
    for (const m of ler(arq).matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)) anota(m[1]!, arq);
  }
  for (const arq of ["deploy/docker-compose.prod.yml", "deploy/logs/docker-compose.yml"]) {
    for (const m of ler(arq).matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)) anota(m[1]!, arq);
  }
  for (const m of ler("deploy/logs/config.alloy").matchAll(/sys\.env\("([A-Z][A-Z0-9_]+)"\)/g)) anota(m[1]!, "deploy/logs/config.alloy");
  return onde;
}

const documentadas = new Set([...ler("docs/variaveis.md").matchAll(/^\| `([A-Z][A-Z0-9_]+)`/gm)].map((m) => m[1]!));

describe("mapa das variáveis (docs/variaveis.md)", () => {
  const onde = usadas();

  it("documenta toda variável lida pelo Omni", () => {
    const faltam = [...onde].filter(([v]) => !documentadas.has(v)).map(([v, arq]) => `${v} (${arq})`);
    expect(faltam).toEqual([]);
  });

  it("não lista variável que ninguém lê", () => {
    expect([...documentadas].filter((v) => !onde.has(v))).toEqual([]);
  });
});
