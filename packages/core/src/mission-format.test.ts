import { describe, expect, it } from "vitest";

import { formatarCnpj, formatarJornada, formatarTelefone, regimeTrabalho } from "./mission-format.ts";

describe("regime de trabalho", () => {
  it("descreve os dias do contrato", () => {
    expect(regimeTrabalho(false, false)).toBe("Seg a sex");
    expect(regimeTrabalho(true, false)).toBe("Seg a sáb");
    expect(regimeTrabalho(true, true)).toBe("Seg a dom");
    expect(regimeTrabalho(false, true)).toBe("Seg a sex e dom");
  });

  it("sem dado não inventa regime", () => {
    expect(regimeTrabalho(null, false)).toBeNull();
  });
});

describe("jornada", () => {
  it("mostra a duração diária", () => {
    expect(formatarJornada("09:00")).toBe("9h/dia");
    expect(formatarJornada("08:30")).toBe("8h30/dia");
    expect(formatarJornada("x")).toBeNull();
  });
});

describe("CNPJ", () => {
  it("formata 14 dígitos", () => {
    expect(formatarCnpj("12345678000190")).toBe("12.345.678/0001-90");
  });

  it("mantém o que não reconhece", () => {
    expect(formatarCnpj("123")).toBe("123");
    expect(formatarCnpj(null)).toBeNull();
  });
});

describe("telefone", () => {
  it("celular e fixo do Brasil, estrangeiro e inválido", () => {
    expect(formatarTelefone("5547999990000")).toBe("(47) 99999-0000");
    expect(formatarTelefone("554733330000")).toBe("(47) 3333-0000");
    expect(formatarTelefone("14155550100")).toBe("+14155550100");
    expect(formatarTelefone("abc")).toBeNull();
    expect(formatarTelefone(null)).toBeNull();
  });
});
