import { describe, expect, it } from "vitest";

import { ehUpload, Limitador, LIMITES_FUNCOES, regraDaRota, semLimite } from "./limites.ts";

describe("Limitador", () => {
  it("deixa passar até o máximo, recusa depois e libera na janela seguinte", () => {
    let t = 0;
    const l = new Limitador(() => t);
    const regra = { nome: "teste", max: 3, janelaMs: 60_000 };
    expect([1, 2, 3].map(() => l.usar("a", regra).ok)).toEqual([true, true, true]);
    const quarto = l.usar("a", regra);
    expect(quarto).toEqual({ ok: false, esperarSegundos: 60, primeiroBloqueio: true });
    t = 30_000;
    expect(l.usar("a", regra)).toEqual({ ok: false, esperarSegundos: 30, primeiroBloqueio: false });
    // Outra chave e outra regra contam à parte.
    expect(l.usar("b", regra).ok).toBe(true);
    expect(l.usar("a", { ...regra, nome: "outra" }).ok).toBe(true);
    t = 60_000;
    expect(l.usar("a", regra).ok).toBe(true);
  });

  it("limpa as janelas vencidas", () => {
    let t = 0;
    const l = new Limitador(() => t);
    l.usar("a", { nome: "x", max: 1, janelaMs: 1000 });
    t = 2 * 3_600_000;
    l.limpar();
    expect(l.tamanho).toBe(0);
  });
});

describe("regras", () => {
  it("o QR code renovado a cada 5 s por 20 minutos não esbarra no limite do conectar WhatsApp", () => {
    let t = 0;
    const l = new Limitador(() => t);
    const regras = LIMITES_FUNCOES.conectarMeuWhatsApp!;
    for (; t < 20 * 60_000; t += 5_000) for (const r of regras) expect(l.usar("p1", r).ok).toBe(true);
  });

  it("login, API e agenda têm regra por rota; webhooks internos e arquivos estáticos ficam de fora", () => {
    expect(regraDaRota("/auth/microsoft")?.nome).toBe("login");
    expect(regraDaRota("/api/v1/tasks")?.max).toBe(120);
    expect(regraDaRota("/api/calendar/apple/feed/x.ics")?.nome).toBe("agenda-ics");
    expect(regraDaRota("/api/missoes")).toBeNull();
    expect(semLimite("/api/whatsapp/webhook")).toBe(true);
    expect(semLimite("/assets/index-abc.js")).toBe(true);
    expect(semLimite("/api/v1/tasks")).toBe(false);
    expect(ehUpload("POST", "/api/canais/arquivo")).toBe(true);
    expect(ehUpload("GET", "/api/canais/arquivo")).toBe(false);
  });

  it("toda função limitada existe com regra positiva", () => {
    for (const [nome, regras] of Object.entries(LIMITES_FUNCOES)) {
      expect(regras.length, nome).toBeGreaterThan(0);
      for (const r of regras) expect(r.max).toBeGreaterThan(0);
    }
  });
});
