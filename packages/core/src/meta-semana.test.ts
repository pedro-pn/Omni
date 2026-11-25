import { describe, expect, it } from "vitest";

import { BusinessCalendar } from "./business-calendar.ts";
import { escolherMetas, periodoMeta, resumoMeta, type MetaFiltroApp } from "./meta-semana.ts";
import { alertasDaMissao, type MissaoRevisao } from "./revisao.ts";

/** Exemplos com a forma real do filtroAPP (03/11/2026). */
const meta = (periodoInicio: string, periodoFim: string, extra: Partial<MetaFiltroApp> = {}): MetaFiltroApp => ({
  situacao: "BELOW",
  rotuloSituacao: "Abaixo da meta",
  emAndamento: false,
  periodoInicio,
  periodoFim,
  regra: "ALL",
  cenario: null,
  atingimentoPct: 89.4,
  itens: [
    {
      tipo: "SERVICE",
      servico: null,
      rotuloServico: null,
      unidade: "M",
      rotuloUnidade: "m",
      base: "PER_PRODUCTIVE_DAY",
      valorCadastrado: 27,
      planejado: 324,
      realizado: 289.77,
      diferenca: -34.23,
      resultado: "BELOW",
      pendenciasBase: [],
      descricao: "Cada colaborador deve fazer 27 m somando todos os serviços por dia trabalhado.",
    },
  ],
  colaboradoresPorDia: [],
  ...extra,
});

describe("meta da semana como cadastrada no filtroAPP", () => {
  it("resume na unidade cadastrada, com o serviço; várias linhas viram atingimento", () => {
    expect(resumoMeta(meta("2026-10-23", "2026-10-29"))).toBe("289,8 de 324 m");
    const un = meta("2026-10-23", "2026-10-29");
    un.itens[0] = { ...un.itens[0]!, unidade: "UN", rotuloUnidade: "un", rotuloServico: "Limpeza química", planejado: 10, realizado: 16 };
    expect(resumoMeta(un)).toBe("16 de 10 un de limpeza química");
    expect(resumoMeta(meta("2026-10-23", "2026-10-29", { itens: [un.itens[0]!, un.itens[0]!], atingimentoPct: 66.6 }))).toBe("67% da meta");
    expect(resumoMeta(meta("2026-10-30", "2026-11-05", { situacao: "NO_DATA", rotuloSituacao: "Sem dados suficientes", atingimentoPct: null, itens: [{ ...un.itens[0]!, planejado: null }] }))).toBe(
      "Sem dados suficientes",
    );
    expect(periodoMeta(meta("2026-10-23", "2026-10-29"))).toBe("23/10 a 29/10");
  });

  it("escolhe a meta de hoje pelo período (sexta a quinta) e a última encerrada; futura não conta", () => {
    const passada = meta("2026-10-23", "2026-10-29");
    const atual = meta("2026-10-30", "2026-11-05", { situacao: "NO_DATA" });
    const futura = meta("2026-11-06", "2026-11-12", { situacao: "PLANNED" });
    expect(escolherMetas([futura, null, passada, atual], "2026-11-03")).toEqual({ atual, ultimaFechada: passada });
    expect(escolherMetas([futura], "2026-11-03")).toEqual({ atual: null, ultimaFechada: null });
    // Encerrada há mais de 7 dias, sem outra depois: não vira alerta.
    expect(escolherMetas([meta("2026-10-16", "2026-10-22")], "2026-11-03").ultimaFechada).toBeNull();
    expect(escolherMetas([meta("2026-10-16", "2026-10-27")], "2026-11-03").ultimaFechada).not.toBeNull();
  });

  it("alerta quando a última meta encerrada não foi cumprida, e substitui a meta em p.p.", () => {
    const base: MissaoRevisao = {
      stage: "EXECUTION",
      fimEmCampo: null,
      usaRdo: false,
      ultimoRdo: null,
      rdosDevolvidos: 0,
      qualidade: { abertos: 0, altoImpacto: 0, acaoVencida: 0 },
      medicao: null,
      notasAtrasadas: 0,
      perguntasSemResposta: 0,
      tarefasAtrasadas: 0,
      avanco: 40,
      avancoSemanaPassada: 30,
      semanaPassada: { avancoInicio: 40, avancoFim: 42, meta: 5 },
    };
    const cal = new BusinessCalendar();
    const textos = (m: Partial<MissaoRevisao>) => alertasDaMissao({ ...base, ...m }, cal, "2026-11-03").map((a) => a.texto);
    expect(textos({ metaFechada: meta("2026-10-23", "2026-10-29") })).toEqual(["Meta de 23/10 a 29/10 não cumprida: 289,8 de 324 m"]);
    expect(textos({ metaFechada: meta("2026-10-23", "2026-10-29", { situacao: "ABOVE" }) })).toEqual([]);
    expect(textos({})).toEqual(["Semana passada abaixo da meta (2 de 5 p.p.)"]);
  });
});
