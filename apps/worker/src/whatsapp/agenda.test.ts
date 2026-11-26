import { describe, expect, it } from "vitest";

import { lerAgendas } from "./agenda.ts";

/** Agenda vazia não grava nem marca a leitura (senão as conversas passariam a aparecer só pelo número). */
describe("leitura da agenda", () => {
  it("lista vazia: não chama o banco para gravar e conta como vazia, com o diagnóstico", async () => {
    const chamadas: string[] = [];
    const db = {
      select: () => ({ from: () => ({ where: async () => [{ id: "n1", telefone: "5547900000001" }] }) }),
      execute: async () => (chamadas.push("execute"), { rows: [{ n: 0 }] }),
    } as unknown as Parameters<typeof lerAgendas>[0];
    const r = await lerAgendas(db, { contatos: async () => ({ contatos: [], completa: false, diagnostico: { versaoDaColecao: 0 }, mensagens: ["info: failed to sync state"] }) });
    expect(r).toMatchObject({ numeros: 1, vazias: 1, contatos: 0, erros: 0, diagnosticos: [{ diagnostico: { versaoDaColecao: 0 }, mensagens: ["info: failed to sync state"] }] });
    expect(chamadas).toEqual([]);
  });

  it("lista parcial: só acrescenta (sem a função que troca a agenda inteira e marca a leitura)", async () => {
    const chamadas: string[] = [];
    const db = {
      select: () => ({ from: () => ({ where: async () => [{ id: "n1", telefone: "5547900000001" }] }) }),
      execute: async () => (chamadas.push("trocar-tudo"), { rows: [{ n: 0 }] }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => chamadas.push("acrescentar") }) }),
    } as unknown as Parameters<typeof lerAgendas>[0];
    const r = await lerAgendas(db, {
      contatos: async () => ({ contatos: [{ jid: "5547900000077@s.whatsapp.net", lid: null, telefone: null, nome: "Bruno" }], completa: false, diagnostico: null, mensagens: [] }),
    });
    expect(r).toMatchObject({ parciais: 1, contatos: 1 });
    expect(chamadas).toEqual(["acrescentar"]);
  });
});
