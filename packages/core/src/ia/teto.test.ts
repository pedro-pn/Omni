import { describe, expect, it } from "vitest";

import { avaliarGastoIa, TETO_PADRAO_IA } from "./teto.ts";

describe("avaliarGastoIa", () => {
  const teto = { tokens: 1000, chamadas: 10 };
  it("abaixo da metade segue", () => expect(avaliarGastoIa({ tokens: 499, chamadas: 4 }, teto).situacao).toBe("ok"));
  it("metade dos tokens ou das chamadas avisa", () => {
    expect(avaliarGastoIa({ tokens: 500, chamadas: 0 }, teto).situacao).toBe("metade");
    expect(avaliarGastoIa({ tokens: 0, chamadas: 5 }, teto).situacao).toBe("metade");
  });
  it("no teto de tokens ou de chamadas para", () => {
    const r = avaliarGastoIa({ tokens: 1000, chamadas: 1 }, teto);
    expect(r.situacao).toBe("teto");
    expect(r.mensagem).toContain("1.000 de 1.000 tokens");
    expect(avaliarGastoIa({ tokens: 0, chamadas: 10 }, teto).situacao).toBe("teto");
  });
  it("teto zero não bloqueia por aquele critério", () => expect(avaliarGastoIa({ tokens: 99, chamadas: 99 }, { tokens: 0, chamadas: 0 }).situacao).toBe("ok"));
  it("o padrão tem folga sobre o pico medido (140 mil tokens)", () => expect(avaliarGastoIa({ tokens: 140_000, chamadas: 240 }, TETO_PADRAO_IA).situacao).toBe("ok"));
});
