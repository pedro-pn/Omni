import { describe, expect, it } from "vitest";

import { comandoDeAlerta, rdosQueDisparam, resumoDaRegra, textoDoDisparo, validarConferencia, validarRegra, type RegraAlertaIA } from "./alerta.ts";

const AUSENCIA: RegraAlertaIA = { fonte: "rdo", tipo: "ausencia", oQue: "metros de tubulação liberados", dias: 2, marcar: "LEADER" };

describe("alertas pedidos à IA", () => {
  it("reconhece o comando no começo da mensagem", () => {
    expect(comandoDeAlerta("@IA me avise se não vier a metragem")).toBe("me avise se não vier a metragem");
    expect(comandoDeAlerta("/alerta: se o RDO falar em parada")).toBe("se o RDO falar em parada");
    expect(comandoDeAlerta("@ia")).toBe("");
    expect(comandoDeAlerta("Falei com a @IA ontem")).toBeNull();
    expect(comandoDeAlerta("@iago tudo certo")).toBeNull();
  });

  it("confere a regra do modelo e devolve a dúvida quando não entendeu", () => {
    expect(validarRegra({ entendi: true, tipo: "ausencia", oQue: "  metros  de tubulação liberados ", dias: 0, marcar: "LEADER", duvida: null })).toEqual({
      regra: { ...AUSENCIA, dias: 2 }, // 0 = não informado: padrão da falta
    });
    expect(validarRegra({ entendi: true, tipo: "presenca", oQue: "parada de bomba", dias: 99, marcar: "xx", duvida: null })).toEqual({
      regra: { fonte: "rdo", tipo: "presenca", oQue: "parada de bomba", dias: 10, marcar: "eu" },
    });
    expect(validarRegra({ entendi: false, duvida: "É sobre e-mails, não RDOs." })).toEqual({ duvida: "É sobre e-mails, não RDOs." });
    expect(validarRegra({ entendi: true, oQue: "x" })).toHaveProperty("duvida");
  });

  it("monta o cartão e o texto do disparo", () => {
    const r = resumoDaRegra(AUSENCIA, "Missão 5851 - Oceanis", "interno");
    expect(r).toContain('a informação de "metros de tubulação liberados"');
    expect(r).toContain("se não aparecer em 2 RDOs seguidos");
    expect(r).toContain("marco o líder de projetos no interno");
    expect(textoDoDisparo(AUSENCIA, "@Ana", [{ nome: "RDO nº 22", data: "2026-11-03" }, { nome: "RDO nº 23", data: "2026-11-04" }], 2)).toBe(
      '@Ana, alerta da missão (2º aviso): não encontrei "metros de tubulação liberados" nos RDO nº 22 (03/11), RDO nº 23 (04/11). São 2 RDOs seguidos sem essa informação. Pode verificar com a equipe em campo?',
    );
  });

  it("trecho do modelo precisa existir no RDO", () => {
    const texto = "Frente liberada pelo cliente: 120 m de linha de retorno.";
    expect(validarConferencia({ presente: true, trecho: "120 m de linha" }, texto)).toEqual({ presente: true, trecho: "120 m de linha" });
    expect(validarConferencia({ presente: true, trecho: "200 metros liberados" }, texto)).toEqual({ presente: false, trecho: null });
    expect(validarConferencia({ presente: false, trecho: null }, texto)).toEqual({ presente: false, trecho: null });
  });

  it("dispara com N RDOs seguidos sem a informação (o que veio no meio zera); presença dispara no primeiro", () => {
    const c = (id: string, data: string, presente: boolean) => ({ reportId: id, data, presente });
    expect(rdosQueDisparam(AUSENCIA, [c("r1", "2026-11-01", false), c("r2", "2026-11-02", true), c("r3", "2026-11-03", false)])).toBeNull();
    expect(rdosQueDisparam(AUSENCIA, [c("r4", "2026-11-04", false), c("r3", "2026-11-03", false), c("r2", "2026-11-02", true)])).toEqual(["r3", "r4"]);
    const presenca: RegraAlertaIA = { ...AUSENCIA, tipo: "presenca", dias: 1 };
    expect(rdosQueDisparam(presenca, [c("r1", "2026-11-01", false), c("r2", "2026-11-02", true)])).toEqual(["r2"]);
    expect(rdosQueDisparam(presenca, [c("r1", "2026-11-01", false)])).toBeNull();
  });
});
