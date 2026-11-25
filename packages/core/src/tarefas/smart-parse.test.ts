import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { findSmartDateHighlight, parseQuickInput, retainPresentIgnoredDateExpressions } from "./smart-parse.ts";

const projects = [{ id: "project-general", name: "Geral" }];
const sections = [{ id: "section-pedroca", name: "Pedroca", projectId: "project-general" }];
const members = [
  { name: "Pedro Augusto", email: "pedro.augusto@filtrovali.com.br" },
  { name: "Otávio Barcelos", email: "otavio.barcelos@filtrovali.com.br" },
];
const defaults = { dueDate: null, priority: 4, projectId: "" };

describe("cadastro rápido de tarefas", () => {
  test("reconhece projeto, pessoa e data sem deixar os comandos no título", () => {
    const result = parseQuickInput(
      "Conferir frete #Geral +Pedro quinta-feira",
      projects,
      sections,
      members,
      defaults,
      "2026-08-17",
      "2026-08-18",
    );

    assert.equal(result.projectId, "project-general");
    assert.equal(result.assigneeEmail, "pedro.augusto@filtrovali.com.br");
    assert.equal(result.dueDate, "2026-08-20");
    assert.equal(result.content, "Conferir frete");
  });

  test("mantém a tarefa privada quando nenhum projeto é informado", () => {
    const result = parseQuickInput(
      "Revisar planejamento amanhã",
      projects,
      sections,
      members,
      defaults,
      "2026-08-17",
      "2026-08-18",
    );

    assert.equal(result.projectId, null);
    assert.equal(result.dueDate, "2026-08-18");
    assert.equal(result.dueTime, null);
    assert.equal(result.content, "Revisar planejamento");
  });

  test("reconhece amanhã com horário e salva data e hora separadamente", () => {
    const result = parseQuickInput(
      "Revisar planejamento amanhã 14:30",
      projects,
      sections,
      members,
      defaults,
      "2026-09-02",
      "2026-09-03",
    );

    assert.equal(result.dueDate, "2026-09-03");
    assert.equal(result.dueTime, "14:30");
    assert.equal(result.content, "Revisar planejamento");
  });

  test("reconhece data numérica com ano curto e horário", () => {
    const result = parseQuickInput(
      "Reunião de acompanhamento 10/10/26 07:30",
      projects,
      sections,
      members,
      defaults,
      "2026-09-02",
      "2026-09-03",
    );

    assert.equal(result.dueDate, "2026-10-10");
    assert.equal(result.dueTime, "07:30");
    assert.equal(result.content, "Reunião de acompanhamento");
  });

  test("reconhece recorrência anual e a data completa escrita no título", () => {
    const result = parseQuickInput(
      "Pagar seguro todo ano 20/09/27",
      projects,
      sections,
      members,
      defaults,
      "2026-09-26",
      "2026-09-27",
    );

    assert.equal(result.content, "Pagar seguro");
    assert.equal(result.recurrence, "yearly");
    assert.equal(result.dueDate, "2027-09-20");
    assert.deepEqual(result.detected.map((token) => token.type), ["recurrence"]);
  });

  test("destaca a frase anual inteira, inclusive a data", () => {
    const content = "Pagar seguro todo ano 20/09/27";
    const highlight = findSmartDateHighlight(content, "2026-09-26", "2026-09-27");

    assert.equal(content.slice(highlight?.start, highlight?.end), "todo ano 20/09/27");
  });

  test("usa a data escolhida no calendário como início da recorrência", () => {
    for (const [expression, rule] of [
      ["todo ano", "yearly"],
      ["toda semana", "interval:1:weeks"],
    ]) {
      const result = parseQuickInput(
        `Pagar seguro ${expression}`,
        projects,
        sections,
        members,
        { ...defaults, dueDate: "2027-09-20" },
        "2026-09-26",
        "2026-09-27",
      );

      assert.equal(result.content, "Pagar seguro");
      assert.equal(result.recurrence, rule);
      assert.equal(result.dueDate, "2027-09-20");
    }
  });

  test("reconhece recorrência semanal com data escrita no título", () => {
    const result = parseQuickInput(
      "Revisar toda semana 20/09/27",
      projects,
      sections,
      members,
      defaults,
      "2026-09-26",
      "2026-09-27",
    );

    assert.equal(result.content, "Revisar");
    assert.equal(result.recurrence, "interval:1:weeks");
    assert.equal(result.dueDate, "2027-09-20");
  });

  test("reconhece horário cheio escrito com às", () => {
    const result = parseQuickInput(
      "Ligar para o cliente amanhã às 7",
      projects,
      sections,
      members,
      defaults,
      "2026-09-02",
      "2026-09-03",
    );

    assert.equal(result.dueDate, "2026-09-03");
    assert.equal(result.dueTime, "07:00");
    assert.equal(result.content, "Ligar para o cliente");
  });

  test("reconhece o atalho de seção e remove o comando do título", () => {
    const result = parseQuickInput(
      "Revisar documentação #Geral /Pedroca",
      projects,
      sections,
      members,
      defaults,
      "2026-08-17",
      "2026-08-18",
    );

    assert.equal(result.projectId, "project-general");
    assert.equal(result.sectionId, "section-pedroca");
    assert.equal(result.content, "Revisar documentação");
    assert.deepEqual(
      result.detected.map((token) => token.type),
      ["project", "section"],
    );
  });

  test("reconhece todos os atalhos quando usados no texto da descrição", () => {
    const result = parseQuickInput(
      "Contexto #Geral /Pedroca +Pedro amanhã 07:30 P1 @urgente",
      projects,
      sections,
      members,
      defaults,
      "2026-09-02",
      "2026-09-03",
    );

    assert.equal(result.content, "Contexto");
    assert.equal(result.projectId, "project-general");
    assert.equal(result.sectionId, "section-pedroca");
    assert.equal(result.assigneeEmail, "pedro.augusto@filtrovali.com.br");
    assert.equal(result.dueDate, "2026-09-03");
    assert.equal(result.dueTime, "07:30");
    assert.equal(result.priority, 1);
    assert.deepEqual(result.labels, ["urgente"]);
  });

  test("mantém uma data ignorada enquanto a expressão continua no título", () => {
    const ignoredDates = retainPresentIgnoredDateExpressions("Revisar 25/08 urgente", ["25/08"]);
    const result = parseQuickInput(
      "Revisar 25/08 urgente",
      projects,
      sections,
      members,
      defaults,
      "2026-08-25",
      "2026-08-26",
      ignoredDates,
    );

    assert.deepEqual(ignoredDates, ["25/08"]);
    assert.equal(result.dueDate, null);
    assert.equal(result.content, "Revisar 25/08 urgente");
  });

  test("volta a reconhecer a mesma data depois que ela é apagada e redigitada", () => {
    const ignoredDates = retainPresentIgnoredDateExpressions("Revisar urgente", ["25/08"]);
    const result = parseQuickInput(
      "Revisar urgente 25/08",
      projects,
      sections,
      members,
      defaults,
      "2026-08-25",
      "2026-08-26",
      ignoredDates,
    );

    assert.deepEqual(ignoredDates, []);
    assert.equal(result.dueDate, "2026-08-25");
    assert.equal(result.content, "Revisar urgente");
  });
});
