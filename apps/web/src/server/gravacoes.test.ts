import { describe, expect, it } from "vitest";

import { faixaPedida } from "./gravacoes.ts";

describe("Range do player das gravações", () => {
  it("formas do cabeçalho, limites e pedidos inválidos", () => {
    expect(faixaPedida(null, 1000)).toBeUndefined();
    expect(faixaPedida("bytes=0-", 1000)).toEqual([0, 999]);
    expect(faixaPedida("bytes=100-199", 1000)).toEqual([100, 199]);
    expect(faixaPedida("bytes=900-5000", 1000)).toEqual([900, 999]);
    expect(faixaPedida("bytes=-100", 1000)).toEqual([900, 999]);
    expect(faixaPedida("bytes=-5000", 1000)).toEqual([0, 999]);
    for (const r of ["bytes=1000-", "bytes=5-2", "bytes=-0", "bytes=-", "items=0-1", "bytes=0-1,5-6"]) expect(faixaPedida(r, 1000)).toBeNull();
  });
});
