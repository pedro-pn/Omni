import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SCRIPT_INICIAL } from "../lib/script-inicial.ts";
import { cabecalhoCsp, comNonce, nonceDaRequisicao, novoNonce, politicaCsp } from "./csp.ts";

describe("CSP", () => {
  it("libera só os scripts do Omni, o nonce da requisição e o script inicial pelo hash", () => {
    const p = politicaCsp("abc123");
    const scripts = p.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scripts).toContain("'nonce-abc123'");
    expect(scripts).toContain(`'sha256-${createHash("sha256").update(SCRIPT_INICIAL).digest("base64")}'`);
    expect(scripts).not.toContain("unsafe-inline");
    expect(scripts).not.toContain("unsafe-eval");
    expect(p).toContain("frame-ancestors 'none'");
    expect(p).toContain("object-src 'none'");
  });

  it("nonce novo a cada requisição, visível só dentro dela", async () => {
    const a = novoNonce();
    expect(a).not.toBe(novoNonce());
    expect(await comNonce(a, async () => nonceDaRequisicao())).toBe(a);
    expect(nonceDaRequisicao()).toBeUndefined();
  });

  it("relatório por padrão; bloqueio só com CSP_MODO=aplicar", () => {
    expect(cabecalhoCsp("relatorio")).toBe("Content-Security-Policy-Report-Only");
    expect(cabecalhoCsp("aplicar")).toBe("Content-Security-Policy");
  });
});
