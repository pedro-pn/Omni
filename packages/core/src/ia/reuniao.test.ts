import { describe, expect, it } from "vitest";

import { entradaResumoReuniao, MAX_CARACTERES_TRANSCRICAO, textoDoResumo, validarResumo, vttParaTexto } from "./reuniao.ts";

const VTT = `WEBVTT

0f1e2d3c-aaaa-bbbb-cccc-1234567890ab/10-0
00:00:01.000 --> 00:00:04.000
<v Ana Souza>Bom dia, vamos falar da mobilização da 5851.</v>

0f1e2d3c-aaaa-bbbb-cccc-1234567890ab/11-0
00:00:04.500 --> 00:00:07.000
<v Ana Souza>O caminhão sai na segunda.</v>

0f1e2d3c-aaaa-bbbb-cccc-1234567890ab/12-0
00:00:07.000 --> 00:00:09.000
<v Bruno Lima>Eu confirmo a PT com o cliente até sexta.</v>
`;

describe("resumo de reunião", () => {
  it("transcrição do Teams vira texto por pessoa, juntando falas seguidas", () => {
    expect(vttParaTexto(VTT)).toBe("Ana Souza: Bom dia, vamos falar da mobilização da 5851. O caminhão sai na segunda.\nBruno Lima: Eu confirmo a PT com o cliente até sexta.");
    expect(vttParaTexto("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSem identificação de quem fala")).toBe("Participante: Sem identificação de quem fala");
  });

  it("corta transcrição longa e avisa", () => {
    const e = entradaResumoReuniao("5851 - alinhamento", "2026-11-05", "x".repeat(MAX_CARACTERES_TRANSCRICAO + 10));
    expect(e).toContain("Data: 05/11/2026");
    expect(e).toContain("[transcrição cortada por tamanho]");
  });

  it("confere o que o modelo devolve e monta o texto do Interno", () => {
    expect(validarResumo({ resumo: "curto" })).toBeNull();
    const r = validarResumo({
      resumo: "Alinhada a mobilização da missão 5851.",
      decisoes: ["Caminhão sai na segunda", ""],
      pendencias: [{ descricao: "Confirmar a PT com o cliente", responsavel: "Bruno Lima", prazo: "sexta" }, { descricao: "" }],
    })!;
    expect(r).toEqual({
      resumo: "Alinhada a mobilização da missão 5851.",
      decisoes: ["Caminhão sai na segunda"],
      pendencias: [{ descricao: "Confirmar a PT com o cliente", responsavel: "Bruno Lima", prazo: "sexta" }],
    });
    const t = textoDoResumo("5851 - alinhamento", "2026-11-05", r);
    expect(t).toContain('Resumo da reunião "5851 - alinhamento" de 05/11');
    expect(t).toContain("• Confirmar a PT com o cliente — Bruno Lima (sexta)");
  });
});
