import { describe, expect, it } from "vitest";

import { pedacosComMencoes } from "./Links.tsx";

describe("marcações no texto", () => {
  const ana = { chave: "222222222222222", nome: "Ana Campo", telefone: "5547900000011", eu: false };
  it("troca só o @ das marcações conhecidas; o resto do texto fica como veio", () => {
    expect(pedacosComMencoes("@222222222222222 e @999999999999 vejam, ana@site.com", [ana])).toEqual([ana, " e @999999999999 vejam, ana@site.com"]);
    expect(pedacosComMencoes("Oi @222222222222222!", [ana])).toEqual(["Oi ", ana, "!"]);
    expect(pedacosComMencoes("sem marcação", undefined)).toEqual(["sem marcação"]);
  });
});
