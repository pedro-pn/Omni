import { describe, expect, it } from "vitest";

import { faixaDe, Medidor, p95, rotaDe, semMedicao } from "./desempenho.ts";

describe("desempenho (E19)", () => {
  it("rota sem identificadores: uuid, número e trechos longos somem", () => {
    expect(rotaDe("get", "/api/tarefas/anexo/3f2b1c4d-1111-4222-8333-444455556666?x=1")).toBe("GET /api/tarefas/anexo/:id");
    expect(rotaDe("GET", "/api/relatorios/123/pdf")).toBe("GET /api/relatorios/:n/pdf");
    expect(rotaDe("GET", "/api/calendar/apple/feed/abc.def0123456789abcdef.ics")).toBe("GET /api/calendar/apple/feed/:x");
    expect(rotaDe("GET", "/api/arquivos/fulano@cliente.com.br/x")).toBe("GET /api/arquivos/:x/x");
    expect(rotaDe("GET", "/")).toBe("GET /");
  });

  it("estáticos, eventos e server functions (medidas pelo nome) ficam de fora", () => {
    for (const c of ["/assets/index-abc.js", "/marca/logo.svg", "/api/eventos", "/_serverFn/abc", "/manifest.webmanifest"]) expect(semMedicao(c), c).toBe(true);
    for (const c of ["/", "/admin", "/api/saude", "/api/v1/tasks"]) expect(semMedicao(c), c).toBe(false);
  });

  it("faixas e p95", () => {
    expect(faixaDe(10)).toBe(0);
    expect(faixaDe(50)).toBe(0);
    expect(faixaDe(51)).toBe(1);
    expect(faixaDe(9000)).toBe(7);
    // 94 rápidas e 6 em até 1 s: o p95 cai na faixa de 1000 ms.
    expect(p95([94, 0, 0, 0, 6, 0, 0, 0], 900)).toBe(900);
    expect(p95([100, 0, 0, 0, 0, 0, 0, 0], 30)).toBe(30);
    expect(p95([0, 0, 0, 0, 0, 0, 0, 3], 12_000)).toBe(12_000);
  });

  it("soma por hora e rota; esvazia; devolve o que não foi gravado", () => {
    let agora = new Date("2026-11-26T10:15:00Z");
    const m = new Medidor(() => agora);
    m.medir("GET /", 40, false);
    m.medir("GET /", 300, true);
    agora = new Date("2026-11-26T11:01:00Z");
    m.medir("GET /", 20, false);
    const lote = m.esvaziar();
    expect(lote).toEqual([
      { hora: "2026-11-26T10:00:00.000Z", rota: "GET /", n: 2, soma: 340, max: 300, erros: 1, faixas: [1, 0, 0, 1, 0, 0, 0, 0] },
      { hora: "2026-11-26T11:00:00.000Z", rota: "GET /", n: 1, soma: 20, max: 20, erros: 0, faixas: [1, 0, 0, 0, 0, 0, 0, 0] },
    ]);
    expect(m.esvaziar()).toEqual([]);
    m.medir("GET /", 10, false);
    m.devolver(lote);
    const depois = m.esvaziar();
    expect(depois.find((x) => x.hora.startsWith("2026-11-26T11"))!.n).toBe(2);
    expect(depois).toHaveLength(2);
  });
});
