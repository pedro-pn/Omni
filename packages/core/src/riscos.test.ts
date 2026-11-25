import { describe, expect, it } from "vitest";

import { avaliarRiscos, enderecoDeFora, LIMITES_RISCO, type UsoDaPessoa } from "./riscos.ts";

const uso = (p: Partial<UsoDaPessoa>): UsoDaPessoa => ({ personId: "p1", downloadsHora: 0, downloadsDia: 0, origensDownload: {}, enviosHora: 0, bytesEnviadosHora: 0, ...p });

describe("alertas de risco", () => {
  it("dia a dia normal não alerta", () => {
    expect(avaliarRiscos([uso({ downloadsHora: 12, downloadsDia: 60, enviosHora: 4, bytesEnviadosHora: 8 * 1024 * 1024 })])).toEqual([]);
  });

  it("downloads em massa pela hora ou pelo dia, com as origens", () => {
    const [a] = avaliarRiscos([uso({ downloadsHora: LIMITES_RISCO.downloadsPorHora, downloadsDia: 45, origensDownload: { sharepoint: 40 } })]);
    expect(a).toMatchObject({ tipo: "downloads_em_massa", personId: "p1", detalhes: { origens: { sharepoint: 40 } } });
    expect(a!.motivo).toContain("última hora");
    expect(avaliarRiscos([uso({ downloadsHora: 5, downloadsDia: LIMITES_RISCO.downloadsPorDia })])[0]!.motivo).toContain("24 horas");
  });

  it("envio para fora por quantidade ou por volume; os dois tipos juntos", () => {
    expect(avaliarRiscos([uso({ enviosHora: 15 })])[0]).toMatchObject({ tipo: "envio_para_fora" });
    expect(avaliarRiscos([uso({ bytesEnviadosHora: 60 * 1024 * 1024 })])[0]!.motivo).toContain("60 MB");
    expect(avaliarRiscos([uso({ downloadsHora: 50, enviosHora: 20 })]).map((a) => a.tipo)).toEqual(["downloads_em_massa", "envio_para_fora"]);
  });

  it("endereço de fora pelo domínio da empresa", () => {
    const empresa = new Set(["filtrovali.com.br"]);
    expect(enderecoDeFora("Fulano@Filtrovali.com.br", empresa)).toBe(false);
    expect(enderecoDeFora("compras@cliente.com.br", empresa)).toBe(true);
    expect(enderecoDeFora("sem-arroba", empresa)).toBe(true);
  });
});
