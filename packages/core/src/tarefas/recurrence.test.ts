import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { readFileSync } from "node:fs";

import { formatRecurrence, nextRecurrenceDate, parseRecurrenceInput } from "./recurrence.ts";

describe("recorrência em português", () => {
  const examples: Array<[string, string]> = [
    ["todo dia", "daily"],
    ["dias úteis", "weekdays"],
    ["toda segunda e quarta", "weekly:1,3"],
    ["a cada 15 dias", "interval:15:days"],
    ["todo dia 23", "monthly:23"],
  ];

  for (const [input, expected] of examples) {
    test(`interpreta ${input}`, () => {
      const result = parseRecurrenceInput(input);

      assert.equal(result.valid, true);
      assert.equal(result.value, expected);
    });
  }

  test("interpreta data inicial escrita na recorrência anual ou semanal", () => {
    for (const [input, rule] of [
      ["todo ano 20/09/27", "yearly"],
      ["toda semana 20/09/27", "interval:1:weeks"],
    ]) {
      const result = parseRecurrenceInput(input);
      assert.equal(result.valid, true);
      assert.equal(result.value, rule);
      assert.equal(result.startDate, "2027-09-20");
    }
    assert.equal(parseRecurrenceInput("todo ano 31/02/27").valid, false);
  });

  test("rejeita uma recorrência ambígua", () => {
    const result = parseRecurrenceInput("quando der");

    assert.equal(result.valid, false);
    assert.equal(result.value, null);
  });

  test("mostra recorrência semanal como toda semana", () => {
    assert.equal(formatRecurrence("interval:1:weeks"), "Toda semana");
  });

  test("formata dias úteis para a interface", () => {
    assert.equal(formatRecurrence("weekdays"), "Dias úteis");
  });

  test("normaliza a recorrência legada importada do Todoist", () => {
    const result = parseRecurrenceInput("interval-months:2");

    assert.equal(result.valid, true);
    assert.equal(result.value, "interval:2:months");
    assert.equal(result.label, "A cada 2 meses");
    assert.equal(formatRecurrence("interval-months:2"), "A cada 2 meses");
  });

  test("adia recorrências diárias e de dias úteis", () => {
    assert.equal(nextRecurrenceDate("daily", "2026-08-23", "2026-08-23"), "2026-08-24");
    assert.equal(nextRecurrenceDate("weekdays", "2026-08-21", "2026-08-21"), "2026-08-24");
  });

  test("usa o próximo dia previsto quando a recorrência está atrasada", () => {
    assert.equal(nextRecurrenceDate("weekly:1,3", "2026-08-17", "2026-08-23"), "2026-08-24");
  });

  test("preserva a referência mensal e limita ao último dia do mês", () => {
    assert.equal(nextRecurrenceDate("monthly:31", "2026-01-31", "2026-01-31"), "2026-02-28");
    assert.equal(nextRecurrenceDate("interval:2:months", "2026-01-31", "2026-01-31"), "2026-03-31");
  });

  test("preserva mês e dia em recorrências anuais", () => {
    assert.equal(nextRecurrenceDate("yearly", "2024-02-29", "2025-03-01"), "2026-02-28");
  });

  test("repete a partir da data escolhida, sem antecipar a primeira ocorrência", () => {
    assert.equal(nextRecurrenceDate("yearly", "2027-09-20", "2027-09-20"), "2028-09-20");
    assert.equal(
      nextRecurrenceDate("interval:1:weeks", "2027-09-20", "2027-09-20"),
      "2027-09-27",
    );
  });

  test("mantém a sequência quinzenal original ao concluir com atraso", () => {
    for (const rule of ["interval:14:days", "interval-days:14", "interval:2:weeks"]) {
      assert.equal(nextRecurrenceDate(rule, "2026-08-25", "2026-09-09"), "2026-09-22");
      assert.equal(nextRecurrenceDate(rule, "2026-08-25", "2026-09-08"), "2026-09-22");
      assert.equal(nextRecurrenceDate(rule, "2026-09-22", "2026-09-09"), "2026-10-06");
      assert.equal(nextRecurrenceDate(rule, "2026-08-25", "2026-10-07"), "2026-10-20");
      assert.equal(nextRecurrenceDate(rule, null, "2026-09-09"), "2026-09-23");
    }
  });

  test("rejeita regra desconhecida ao calcular a próxima data", () => {
    assert.equal(nextRecurrenceDate("quando der", "2026-08-23", "2026-08-23"), null);
  });
});

const cases = JSON.parse(
  readFileSync(new URL("./recurrence-cases.json", import.meta.url), "utf8"),
) as Array<[string, string | null, string, string | null]>;
for (const [rule, previous, reference, expected] of cases) {
  test(`calendário: ${rule} / ${previous} / ${reference}`, () => {
    assert.equal(nextRecurrenceDate(rule, previous, reference), expected);
    if (expected) {
      assert.ok(parseRecurrenceInput(rule).valid);
      assert.ok(!formatRecurrence(rule.trim()).includes("não reconhecida"));
    }
  });
}
