import { describe, expect, it } from "vitest";

import { descreverVencimento } from "./vencimento.ts";

const agora = new Date("2026-10-28T17:00:00Z"); // 14h em São Paulo

describe("descreverVencimento", () => {
  it("credencial de 3 meses mostra a data", () => {
    expect(descreverVencimento("2027-01-28T16:45:51Z", agora)).toEqual({ texto: "28/01/2027", perto: false, vencido: false });
  });

  it("perto de vencer avisa e mostra hoje/amanhã com a hora local", () => {
    expect(descreverVencimento("2026-10-28T20:30:00Z", agora)).toEqual({ texto: "hoje, 17:30", perto: true, vencido: false });
    expect(descreverVencimento("2026-10-29T12:00:00Z", agora)).toMatchObject({ texto: "amanhã, 09:00", perto: true });
    expect(descreverVencimento("2026-11-03T12:00:00Z", agora).perto).toBe(true);
  });

  it("vencida", () => {
    expect(descreverVencimento("2026-10-28T16:00:00Z", agora)).toMatchObject({ vencido: true, perto: false });
  });
});
