import { describe, expect, it } from "vitest";

import { montarAgenda, nomeDaConversa, nomeDoAutor } from "./nomes-whatsapp.ts";

const agenda = montarAgenda([{ jid: "5547900000011@s.whatsapp.net", lid: "999001@lid", phone: "5547900000011", savedName: "Ana (obra)" }]);
const pessoa = (extra: Partial<Parameters<typeof nomeDaConversa>[0]>) => ({ grupo: false, nome: "Ana Perfil", nomeManual: false, telefone: "5547900000011", jid: "5547900000011@s.whatsapp.net", lid: null, ...extra });

describe("nomes do WhatsApp como no WhatsApp Web", () => {
  it("salvo na agenda: o nome salvo (pelo número ou pelo @lid)", () => {
    expect(nomeDaConversa(pessoa({}), agenda)).toEqual({ nome: "Ana (obra)", perfil: null, salvo: true });
    expect(nomeDaConversa(pessoa({ telefone: null, jid: "999001@lid", lid: "999001@lid" }), agenda)).toMatchObject({ nome: "Ana (obra)", salvo: true });
  });
  it("não salvo: o número, com o nome de perfil à parte; sem número, o perfil com ~", () => {
    expect(nomeDaConversa(pessoa({ telefone: "5547900000078", jid: "5547900000078@s.whatsapp.net", nome: "Bruno" }), agenda)).toEqual({ nome: "(47) 90000-0078", perfil: "Bruno", salvo: false });
    expect(nomeDaConversa(pessoa({ telefone: null, jid: "123@lid", nome: "Bruno" }), agenda)).toEqual({ nome: "~ Bruno", perfil: null, salvo: false });
  });
  it("nome dado no Omni vale; agenda ainda não lida: o nome de sempre; grupo: o nome do grupo", () => {
    expect(nomeDaConversa(pessoa({ telefone: "5547900000078", nomeManual: true, nome: "Fornecedor X" }), agenda)).toMatchObject({ nome: "Fornecedor X", salvo: true });
    expect(nomeDaConversa(pessoa({ telefone: "5547900000078" }), null)).toMatchObject({ nome: "Ana Perfil" });
    expect(nomeDaConversa(pessoa({ grupo: true, nome: "Obra" }), agenda)).toMatchObject({ nome: "Obra" });
  });
  it("autor no grupo", () => {
    expect(nomeDoAutor("5547900000011@s.whatsapp.net", "Ana Perfil", agenda)).toEqual({ autor: "Ana (obra)", perfil: null });
    expect(nomeDoAutor("5547900000078@s.whatsapp.net", "Bruno", agenda)).toEqual({ autor: "(47) 90000-0078", perfil: "Bruno" });
    expect(nomeDoAutor("5547900000078@s.whatsapp.net", "Bruno", null)).toEqual({ autor: "Bruno", perfil: null });
  });
});
