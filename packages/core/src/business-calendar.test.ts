import { describe, expect, it } from "vitest";

import { BusinessCalendar, easterDate, nationalHolidays, type Holiday } from "./business-calendar.ts";

const itajai2026: Holiday[] = [
  { date: "2026-06-15", name: "Aniversário de Itajaí", scope: "municipal", city: "Itajaí" },
  { date: "2026-12-08", name: "Imaculada Conceição", scope: "municipal", city: "Itajaí" },
];

const cal = new BusinessCalendar({ extraHolidays: itajai2026 });
// 08h em São Paulo = 11h UTC (sem horário de verão desde 2019)
const sp = (iso: string) => new Date(`${iso}-03:00`);

describe("feriados nacionais", () => {
  it("calcula a Páscoa", () => {
    expect(easterDate(2026)).toBe("2026-04-05");
    expect(easterDate(2027)).toBe("2027-03-28");
  });

  it("inclui Carnaval (segunda e terça), Paixão e Corpus Christi, como o filtroAPP", () => {
    const dates = nationalHolidays(2027).map((h) => `${h.date} ${h.name}`);
    expect(dates).toContain("2027-02-08 Carnaval");
    expect(dates).toContain("2027-02-09 Carnaval");
    expect(dates).toContain("2027-03-26 Paixão de Cristo");
    expect(dates).toContain("2027-05-27 Corpus Christi");
  });

  it("bate com a lista usada no protótipo para 2026", () => {
    for (const key of ["2026-04-03", "2026-06-04", "2026-11-20", "2026-12-25"]) {
      expect(cal.isBusinessDay(key)).toBe(false);
    }
  });
});

describe("dias úteis", () => {
  it("fim de semana e feriado municipal não são úteis", () => {
    expect(cal.isBusinessDay("2026-10-24")).toBe(false); // sábado
    expect(cal.isBusinessDay("2026-06-15")).toBe(false); // aniversário de Itajaí
    expect(cal.isBusinessDay("2026-10-26")).toBe(true);
  });

  it("D-1 útil de uma segunda é a sexta", () => {
    expect(cal.previousBusinessDay("2026-11-09")).toBe("2026-11-06");
  });

  it("D-5 úteis pula o feriado de Finados", () => {
    // 02/11 é feriado; 5 úteis antes de 09/11: 06, 05, 04, 03, 30/10
    expect(cal.previousBusinessDay("2026-11-09", 5)).toBe("2026-10-30");
  });

  it("lista os feriados no meio de um intervalo", () => {
    expect(cal.holidaysBetween("2026-11-01", "2026-11-21").map((h) => h.date)).toEqual([
      "2026-11-02",
      "2026-11-15",
      "2026-11-20",
    ]);
  });
});

describe("janela de envio da IA (seg–sex, 08–18h)", () => {
  it("dentro da janela envia na hora", () => {
    const t = sp("2026-10-30T17:55:00");
    expect(cal.nextSendSlot(t).toISOString()).toBe(t.toISOString());
  });

  it("às 18h de sexta vai para segunda às 8h", () => {
    expect(cal.nextSendSlot(sp("2026-10-30T18:00:00")).toISOString()).toBe("2026-11-03T11:00:00.000Z");
    // segunda 02/11 é Finados, então terça 03/11
  });

  it("antes das 8h de um dia útil espera até as 8h", () => {
    expect(cal.nextSendSlot(sp("2026-10-27T06:30:00")).toISOString()).toBe("2026-10-27T11:00:00.000Z");
  });

  it("véspera de feriado à noite pula o feriado e o fim de semana", () => {
    // quinta 19/11 18h30 → sexta 20/11 é feriado → segunda 23/11
    expect(cal.nextSendSlot(sp("2026-11-19T18:30:00")).toISOString()).toBe("2026-11-23T11:00:00.000Z");
  });

  it("no Carnaval não envia", () => {
    expect(cal.nextSendSlot(sp("2027-02-08T10:00:00")).toISOString()).toBe("2027-02-10T11:00:00.000Z");
  });

  it("não depende do fuso do servidor", () => {
    expect(cal.dateKeyOf(new Date("2026-10-27T02:00:00.000Z"))).toBe("2026-10-26");
  });
});
