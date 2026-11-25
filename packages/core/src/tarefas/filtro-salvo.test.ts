import { describe, expect, it } from "vitest";

import { tarefaCombinaComFiltro, type TarefaParaFiltro } from "./filtro-salvo.ts";

const hoje = "2026-11-10";
const pessoas = [
  { nome: "Ana Souza", email: "ana.souza@filtrovali.com.br" },
  { nome: "Bruno Lima", email: "bruno@filtrovali.com.br" },
];
const base: TarefaParaFiltro = {
  titulo: "Enviar relatório de flushing",
  descricao: "Conferir com o cliente",
  data: hoje,
  prioridade: 1,
  etiquetas: ["Campo", "Urgente"],
  concluida: false,
  projetoNome: "Missão 5719 – Itaporã",
  responsavelEmail: "ana.souza@filtrovali.com.br",
};
const ok = (consulta: string, t: Partial<TarefaParaFiltro> = {}) => tarefaCombinaComFiltro({ ...base, ...t }, consulta, { hoje, pessoas });

describe("filtros salvos (linguagem do Foco)", () => {
  it("datas: hoje, amanhã, atrasada, 7 dias, sem data; concluída não conta como prazo", () => {
    expect(ok("hoje")).toBe(true);
    expect(ok("amanhã", { data: "2026-11-11" })).toBe(true);
    expect(ok("atrasadas", { data: "2026-11-09" })).toBe(true);
    expect(ok("atrasada")).toBe(false);
    expect(ok("7 dias", { data: "2026-11-17" })).toBe(true);
    expect(ok("próximos 7 dias", { data: "2026-11-18" })).toBe(false);
    expect(ok("sem data", { data: null })).toBe(true);
    expect(ok("hoje", { concluida: true })).toBe(false);
    expect(ok("concluídas", { concluida: true })).toBe(true);
    expect(ok("abertas")).toBe(true);
  });

  it("prioridade, etiqueta, projeto e texto, sem acentos nem maiúsculas", () => {
    expect(ok("p1")).toBe(true);
    expect(ok("P2")).toBe(false);
    expect(ok("@urgente")).toBe(true);
    expect(ok("@urg")).toBe(false); // etiqueta é exata
    expect(ok("#missao 5719")).toBe(true);
    expect(ok("projeto: itapora")).toBe(true);
    expect(ok("flushing")).toBe(true);
    expect(ok("cliente")).toBe(true);
  });

  it("pessoa: +nome ou começo do e-mail; responsavel: por parte do nome ou do e-mail", () => {
    expect(ok("+ana")).toBe(true);
    expect(ok("+bruno")).toBe(false);
    expect(ok("responsavel: souza")).toBe(true);
    expect(ok("+ninguem")).toBe(false);
  });

  it("combinações: & é E, | é OU, ! nega (e !! desfaz)", () => {
    expect(ok("hoje & p1")).toBe(true);
    expect(ok("hoje & p2")).toBe(false);
    expect(ok("hoje & p2 | @campo")).toBe(true);
    expect(ok("!@campo")).toBe(false);
    expect(ok("!!@campo")).toBe(true);
    expect(ok("hoje & !+bruno")).toBe(true);
  });
});
