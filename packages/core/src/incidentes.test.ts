import { describe, expect, it } from "vitest";

import { faltasDoIncidente, type IncidenteParaConferir } from "./incidentes.ts";

const base: IncidenteParaConferir = {
  status: "aberto",
  inicio: "2026-11-26T14:52:00Z",
  conhecidoEm: "2026-11-26T14:53:00Z",
  resolvidoEm: null,
  dadosPessoais: false,
  titulares: null,
  causa: null,
  correcao: null,
  comunicacoes: null,
};

describe("faltasDoIncidente", () => {
  it("aberto só confere as datas", () => {
    expect(faltasDoIncidente(base)).toEqual([]);
    expect(faltasDoIncidente({ ...base, conhecidoEm: "2026-11-26T14:00:00Z" })).toHaveLength(1);
  });

  it("resolvido precisa da hora da solução", () => {
    expect(faltasDoIncidente({ ...base, status: "resolvido" })).toEqual(["Informe quando voltou ao normal."]);
    expect(faltasDoIncidente({ ...base, status: "resolvido", resolvidoEm: "2026-11-26T14:55:00Z" })).toEqual([]);
  });

  it("encerrado precisa da causa e da correção", () => {
    const r = { ...base, status: "encerrado" as const, resolvidoEm: "2026-11-26T14:55:00Z" };
    expect(faltasDoIncidente(r)).toEqual(["Escreva a causa.", "Escreva o que muda para não repetir."]);
    expect(faltasDoIncidente({ ...r, causa: "  ab ", correcao: "nova trava" })).toEqual(["Escreva a causa."]);
    expect(faltasDoIncidente({ ...r, causa: "drop no lugar errado", correcao: "descarte na descoberta" })).toEqual([]);
  });

  it("com dado pessoal, encerrado precisa dos titulares e das comunicações", () => {
    const r = { ...base, status: "encerrado" as const, resolvidoEm: "2026-11-26T14:55:00Z", causa: "causa", correcao: "correção", dadosPessoais: true };
    expect(faltasDoIncidente(r)).toHaveLength(2);
    expect(faltasDoIncidente({ ...r, titulares: "contatos do WhatsApp", comunicacoes: "não necessária: mascarado" })).toEqual([]);
  });
});
