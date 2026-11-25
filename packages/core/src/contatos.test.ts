import { describe, expect, it } from "vitest";

import { ehCelular, nomeParaComparar, telefoneCanonico, telefonesNoTexto } from "./contatos.ts";

describe("telefoneCanonico", () => {
  it("DDD e número viram 55 + DDD + número; o 9 entra no celular antigo do WhatsApp", () => {
    expect(telefoneCanonico("(47) 99123-4567")).toBe("5547991234567");
    expect(telefoneCanonico("047 99123-4567")).toBe("5547991234567");
    expect(telefoneCanonico("+55 47 99123-4567")).toBe("5547991234567");
    expect(telefoneCanonico("554791234567")).toBe("5547991234567"); // jid do WhatsApp sem o 9
    expect(telefoneCanonico("(47) 3333-4444")).toBe("554733334444"); // fixo não ganha 9
    expect(telefoneCanonico("5547991234567")).toBe("5547991234567");
  });
  it("outros países e lixo", () => {
    expect(telefoneCanonico("+1 415 555 0100")).toBe("14155550100");
    expect(telefoneCanonico("(55) 99123-4567")).toBe("5555991234567"); // DDD 55
    expect(telefoneCanonico("+351 912 345 678")).toBe("351912345678");
    expect(telefoneCanonico("1234")).toBeNull();
    expect(telefoneCanonico("")).toBeNull();
    expect(telefoneCanonico(null)).toBeNull();
  });
});

describe("nomeParaComparar", () => {
  it("sem acento e caixa; exige nome e sobrenome", () => {
    expect(nomeParaComparar("  Ana  Clára ")).toBe("ana clara");
    expect(nomeParaComparar("ANA CLARA - Compras")).toBe("ana clara compras");
    expect(nomeParaComparar("Ana")).toBeNull();
    expect(nomeParaComparar("+55 47 9999")).toBeNull();
  });
});


describe("telefonesNoTexto", () => {
  it("acha telefones escritos como telefone", () => {
    const texto = [
      "Me liga no (47) 99123-4567 ou no 47 3333-4444.",
      "Celular: +55 11 98765-4321 | WhatsApp 21.99876.5432",
      "Tel. (048) 3222-1111",
    ].join("\n");
    expect(telefonesNoTexto(texto).sort()).toEqual(["5511987654321", "5521998765432", "5547991234567", "554733334444", "554832221111"].sort());
  });
  it("não confunde com CNPJ, CPF, nota, protocolo, CEP ou data", () => {
    const texto = "CNPJ 12.345.678/0001-90, CPF 123.456.789-09, NF 1234567890, protocolo 4799123456, CEP 88301-000, em 24/11/2026, valor R$ 1.234.567,00";
    expect(telefonesNoTexto(texto)).toEqual([]);
  });
  it("DDD inexistente não vale; celular e fixo", () => {
    expect(telefonesNoTexto("(20) 99999-1111")).toEqual([]);
    expect(ehCelular("5547991234567")).toBe(true);
    expect(ehCelular("554733334444")).toBe(false);
  });
});
