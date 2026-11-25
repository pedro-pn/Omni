import { describe, expect, it } from "vitest";

import { caminhoDeVolta } from "./caminho-volta.ts";

describe("caminhoDeVolta", () => {
  it("aceita caminhos do próprio Omni", () => {
    expect(caminhoDeVolta("/?integracao=prisma&state=ab")).toBe("/?integracao=prisma&state=ab");
    expect(caminhoDeVolta("/?task=8c1b5b0a-6c8e-4c3e-9a51-2f0f3f8a1d11")).toBe("/?task=8c1b5b0a-6c8e-4c3e-9a51-2f0f3f8a1d11");
  });

  it("recusa outro site, protocolos e lixo", () => {
    for (const ruim of ["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "/a\nb", "/a\\b", "", 42, null, "x".repeat(2001)]) {
      expect(caminhoDeVolta(ruim)).toBe("/");
    }
  });
});
