import { describe, expect, it } from "vitest";

import { vincularEmail, type MissaoVinculavel } from "./emails.ts";

const m = (id: string, code: string, extra: Partial<MissaoVinculavel> = {}): MissaoVinculavel => ({
  id,
  code,
  propostas: [],
  notas: [],
  dominios: [],
  ativa: true,
  ...extra,
});
const missoes = [
  m("a", "5851", { propostas: ["4603"], notas: ["001234"], dominios: ["oceanis.com.br"] }),
  m("b", "5849", { propostas: ["090001/2026"], dominios: ["cliente-a.com.br"] }),
  m("c", "5854", { dominios: ["cliente-a.com.br"] }), // mesmo cliente: domínio fica ambíguo
  m("d", "5700", { ativa: false, dominios: ["antiga.com.br"] }),
];
const vinc = (assunto: string, texto = "", enderecos: string[] = []) =>
  vincularEmail({ assunto, texto, enderecos }, missoes).map((v) => `${v.missionId}:${v.motivo}:${v.detalhe}`);

describe("vínculo de e-mails com missões", () => {
  it("número da missão no assunto (vários formatos) e no texto", () => {
    expect(vinc("RE: Missão 5851 - mobilização")).toEqual(["a:numero:Missão 5851 no assunto"]);
    expect(vinc("ENC: 5851 - Oceanis - cronograma")).toEqual(["a:numero:Missão 5851 no assunto"]);
    expect(vinc("Relatório [5849]")).toEqual(["b:numero:Missão 5849 no assunto"]);
    expect(vinc("Dúvida", "Sobre a missao nº 5849, segue...")).toEqual(["b:numero:Missão 5849 no texto"]);
    // Número que não é de missão conhecida, ou ano solto, não liga.
    expect(vinc("Missão 9999")).toEqual([]);
    expect(vinc("Planejamento 2026", "Reunião em 5851 metros de tubulação")).toEqual([]);
  });

  it("proposta e NF citadas", () => {
    expect(vinc("Revisão", "Segue a Proposta Comercial 4603 Rev 1")).toEqual(["a:proposta:Proposta 4603 citada"]);
    expect(vinc("Pedido", "conforme 090001/2026")).toEqual(["b:proposta:Proposta 090001/2026 citada"]);
    expect(vinc("Pagamento", "Referente à NF 1234")).toEqual(["a:nf:NF 1234 citada"]);
    // Número parecido, mas sem a palavra "proposta"/"NF", não liga.
    expect(vinc("Pedido 4603")).toEqual([]);
  });

  it("domínio do cliente só quando aponta para uma única missão ativa", () => {
    expect(vinc("Olá", "", ["joao@oceanis.com.br", "eu@filtrovali.com.br"])).toEqual(["a:dominio:Domínio do cliente (oceanis.com.br)"]);
    expect(vinc("Olá", "", ["ana@cliente-a.com.br"])).toEqual([]); // duas missões ativas do mesmo cliente
    expect(vinc("Olá", "", ["x@antiga.com.br"])).toEqual([]); // missão inativa
    expect(vinc("Olá", "", ["alguem@gmail.com"])).toEqual([]);
  });

  it("vários motivos para a mesma missão ficam todos, sem repetir", () => {
    // O número no assunto e no texto conta uma vez (o primeiro motivo encontrado fica).
    expect(vinc("Missão 5851", "Missão 5851 — proposta 4603", ["x@oceanis.com.br"]).sort()).toEqual([
      "a:dominio:Domínio do cliente (oceanis.com.br)",
      "a:numero:Missão 5851 no assunto",
      "a:proposta:Proposta 4603 citada",
    ]);
  });
});
