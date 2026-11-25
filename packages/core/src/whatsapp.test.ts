import { describe, expect, it } from "vitest";

import { dentroDoLimite, missoesNoNomeDoGrupo, podeSairPeloWhatsApp } from "./whatsapp.ts";

describe("travas do WhatsApp", () => {
  it("mensagens do Interno, do Gerencial, da IA e de e-mail nunca saem pelo WhatsApp", () => {
    expect(podeSairPeloWhatsApp("conversa")).toBe(true);
    for (const origem of ["interno", "gerencial", "ia", "email", "", "Conversa"]) expect(podeSairPeloWhatsApp(origem)).toBe(false);
  });

  it("sem disparo em massa", () => {
    expect(dentroDoLimite({ pessoa: 9, numero: 19 })).toBe(true);
    expect(dentroDoLimite({ pessoa: 10, numero: 0 })).toBe(false);
    expect(dentroDoLimite({ pessoa: 0, numero: 20 })).toBe(false);
  });
});

describe("grupo ↔ missão pelo nome", () => {
  const missoes = [{ code: "5851" }, { code: "5719" }, { code: "12345" }];
  it("acha o número da missão no nome do grupo", () => {
    expect(missoesNoNomeDoGrupo("5851 - Oceanis", missoes)).toEqual([{ code: "5851" }]);
    expect(missoesNoNomeDoGrupo("Missão 5719 | Itaporã", missoes)).toEqual([{ code: "5719" }]);
    expect(missoesNoNomeDoGrupo("Obra 5851/Itaporã e 5719", missoes)).toEqual([{ code: "5851" }, { code: "5719" }]);
    expect(missoesNoNomeDoGrupo("Projeto 12345", missoes)).toEqual([{ code: "12345" }]);
  });
  it("não confunde com datas, valores, telefones e números maiores", () => {
    expect(missoesNoNomeDoGrupo("Reunião 05/11/2026", missoes)).toEqual([]);
    expect(missoesNoNomeDoGrupo("Compras 5.851,00", missoes)).toEqual([]);
    expect(missoesNoNomeDoGrupo("Contato 47 99585 1000", missoes)).toEqual([]);
    expect(missoesNoNomeDoGrupo("Lote 585123", missoes)).toEqual([]);
    expect(missoesNoNomeDoGrupo(null, missoes)).toEqual([]);
  });
});

