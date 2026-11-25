import { describe, expect, it } from "vitest";

import { etapaInfo, etapaResumo, tituloMissao } from "./mission-stages.ts";

describe("etapas da missão", () => {
  it("segue a ordem e os rótulos do filtroAPP", () => {
    expect(etapaInfo("HANDOVER")).toMatchObject({ posicao: 1, total: 11, rotulo: "Handover comercial" });
    expect(etapaInfo("EXECUTION")).toMatchObject({ posicao: 7, rotulo: "Em execução" });
    expect(etapaInfo("FINISHED")).toMatchObject({ posicao: 11, rotulo: "Encerrado" });
  });

  it("resume a etapa como no protótipo", () => {
    expect(etapaResumo("POST_JOB")).toBe("Etapa 9/11 · Pós-job / fechamento técnico");
  });

  it("missão sem workflow ou com etapa desconhecida não quebra", () => {
    expect(etapaInfo(null)).toBeNull();
    expect(etapaInfo("ETAPA_NOVA")).toBeNull();
    expect(etapaResumo(null)).toBe("Sem acompanhamento no filtroAPP");
  });

  it("monta o título no padrão dos grupos", () => {
    expect(tituloMissao("5843", " Maremar ")).toBe("Missão 5843 - Maremar");
    expect(tituloMissao("5843", "")).toBe("Missão 5843");
  });
});
