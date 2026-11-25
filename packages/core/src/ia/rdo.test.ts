import { describe, expect, it } from "vitest";

import { BusinessCalendar } from "../business-calendar.ts";
import { fluxo, FLUXOS_FORA_DA_AGENDA } from "./fluxos.ts";
import { entradaLeituraRdo, textoDosPontos, validarPontosDoModelo, verificarRegime, type RdoParaLeitura } from "./rdo.ts";

const cal = new BusinessCalendar();
const rdo = (data: string, extra: Partial<RdoParaLeitura> = {}): RdoParaLeitura => ({
  data,
  texto: "Flushing do sistema hidráulico. Bomba principal parada aguardando peça do fornecedor. Cliente não liberou a PT do setor B.",
  minutosTrabalhados: 528,
  minutosExtras: null,
  motivoExtra: null,
  ...extra,
});
const semFimDeSemana = { trabalhaSabado: false, trabalhaDomingo: false, jornada: "8h48" };

describe("leitura do RDO: regras do regime (sem IA)", () => {
  it("trabalho no sábado, domingo ou feriado fora do regime; hora extra sem motivo", () => {
    expect(verificarRegime(rdo("2026-11-07"), semFimDeSemana, cal).map((p) => p.tipo)).toEqual(["fora_do_regime"]); // sábado
    expect(verificarRegime(rdo("2026-11-08"), semFimDeSemana, cal)[0]?.resumo).toMatch(/domingo/);
    expect(verificarRegime(rdo("2026-11-20"), semFimDeSemana, cal)[0]?.resumo).toMatch(/feriado/); // Consciência Negra
    expect(verificarRegime(rdo("2026-11-07"), { ...semFimDeSemana, trabalhaSabado: true }, cal)).toEqual([]);
    expect(verificarRegime(rdo("2026-11-05", { minutosExtras: 120 }), semFimDeSemana, cal)).toEqual([
      { tipo: "hora_extra_sem_motivo", resumo: "2 h de hora extra sem motivo registrado.", trecho: null },
    ]);
    expect(verificarRegime(rdo("2026-11-05", { minutosExtras: 120, motivoExtra: "Atraso do cliente" }), semFimDeSemana, cal)).toEqual([]);
    expect(verificarRegime(rdo("2026-11-07", { minutosTrabalhados: 0 }), semFimDeSemana, cal)).toEqual([]); // não trabalhou
  });
});

describe("leitura do RDO: o que o modelo devolve é conferido", () => {
  const texto = rdo("2026-11-05").texto;
  it("aceita só citação que existe no texto (mesmo com acento ou caixa diferente), tipo conhecido e resumo", () => {
    const pontos = validarPontosDoModelo(
      [
        { tipo: "equipamento_parado", resumo: "Bomba principal parada à espera de peça.", trecho: "bomba principal parada aguardando peca" },
        { tipo: "cliente_travando", resumo: "Sem PT do setor B.", trecho: "Cliente não liberou a PT do setor B" },
        { tipo: "falta_material", resumo: "Inventado pelo modelo.", trecho: "faltou elemento filtrante" },
        { tipo: "tipo_novo", resumo: "Tipo desconhecido.", trecho: "Flushing do sistema" },
        { tipo: "seguranca", resumo: "x", trecho: "Flushing do sistema hidráulico" },
      ],
      texto,
    );
    expect(pontos.map((p) => p.tipo)).toEqual(["equipamento_parado", "cliente_travando"]);
    expect(validarPontosDoModelo("lixo", texto)).toEqual([]);
  });

  it("entrada e texto da pergunta", () => {
    expect(entradaLeituraRdo(rdo("2026-11-07", { minutosExtras: 90, motivoExtra: "atraso" }), semFimDeSemana)).toContain("07/11/2026 (sábado)");
    const pontos = textoDosPontos([{ tipo: "cliente_travando", resumo: "Sem PT do setor B.", trecho: "Cliente não liberou a PT" }]);
    expect(pontos).toBe("• Cliente travando o serviço (liberação, acesso, documentação): Sem PT do setor B. (“Cliente não liberou a PT”)");
    const texto = fluxo("rdo_leitura")!.texto({
      missao: { codigo: "5851", titulo: "Missão 5851 - Oceanis" },
      relatorio: { id: "r", tipo: "RDO", numero: "12", data: "2026-11-05" },
      leitura: { pontos, quantidade: 1 },
    });
    expect(texto).toContain("Li o RDO nº 12 de 05/11/2026 da Missão 5851 - Oceanis e encontrei este ponto:\n• Cliente travando");
    expect(FLUXOS_FORA_DA_AGENDA.has("rdo_leitura")).toBe(true);
    // Número que já traz o tipo não repete ("RDO 23", não "RDO nº RDO 23").
    const comPrefixo = fluxo("rdo_leitura")!.texto({ missao: { codigo: "1", titulo: "M" }, relatorio: { id: "r", tipo: "RDO", numero: "RDO 23", data: "2026-11-02" }, leitura: { pontos: "x", quantidade: 1 } });
    expect(comPrefixo).toMatch(/^Li o RDO 23 de 02\/11\/2026/);
  });
});
