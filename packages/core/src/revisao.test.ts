import { describe, expect, it } from "vitest";

import { BusinessCalendar } from "./business-calendar.ts";
import { alertasDaMissao, diasCorridos, diasUteisEntre, segundaDaSemana, type MissaoRevisao } from "./revisao.ts";

const cal = new BusinessCalendar();
const base: MissaoRevisao = {
  stage: "EXECUTION",
  fimEmCampo: null,
  usaRdo: true,
  ultimoRdo: "2026-11-05",
  rdosDevolvidos: 0,
  qualidade: { abertos: 0, altoImpacto: 0, acaoVencida: 0 },
  medicao: null,
  notasAtrasadas: 0,
  perguntasSemResposta: 0,
  tarefasAtrasadas: 0,
  avanco: 40,
  avancoSemanaPassada: 30,
};
const codigos = (m: Partial<MissaoRevisao>, hoje = "2026-11-06") => alertasDaMissao({ ...base, ...m }, cal, hoje).map((a) => a.codigo);

describe("revisão semanal: alertas", () => {
  it("missão em dia não gera alerta", () => {
    expect(codigos({})).toEqual([]);
  });

  it("dias úteis pulam fim de semana e feriado (20/11)", () => {
    expect(diasUteisEntre("2026-11-06", "2026-11-09", cal)).toBe(1);
    expect(diasUteisEntre("2026-11-19", "2026-11-23", cal)).toBe(1);
  });

  it("sem RDO há mais de 2 dias úteis em execução; missão sem RDO nenhum não é cobrada", () => {
    expect(codigos({ ultimoRdo: "2026-11-03" }, "2026-11-06")).toContain("sem_rdo");
    expect(codigos({ ultimoRdo: "2026-11-04" }, "2026-11-06")).not.toContain("sem_rdo");
    expect(codigos({ usaRdo: false, ultimoRdo: null })).not.toContain("sem_rdo");
  });

  it("medição parada depois do campo, aprovação parada e saldo", () => {
    const pos = { stage: "POST_JOB", fimEmCampo: "2026-10-20", avanco: null, avancoSemanaPassada: null };
    expect(codigos(pos, "2026-11-06")).toContain("medicao_parada");
    expect(codigos({ ...pos, medicao: { situacao: "ENVIADA", enviadaEm: "2026-10-20", saldoPendente: null } }, "2026-11-06")).toEqual(["aprovacao_parada"]);
    expect(codigos({ ...pos, medicao: { situacao: "APROVADA", enviadaEm: "2026-10-20", saldoPendente: true } })).toEqual(["saldo"]);
  });

  it("Qualidade: impacto alto e prazo vencido são graves; só abertos é médio", () => {
    expect(alertasDaMissao({ ...base, qualidade: { abertos: 2, altoImpacto: 1, acaoVencida: 0 } }, cal, "2026-11-06")[0]).toMatchObject({
      codigo: "qualidade_alto",
      gravidade: "alta",
    });
    expect(codigos({ qualidade: { abertos: 2, altoImpacto: 0, acaoVencida: 0 } })).toEqual(["qualidade_aberta"]);
  });

  it("graves primeiro; sem avanço na semana; tarefas e IA", () => {
    const a = alertasDaMissao({ ...base, avanco: 30, notasAtrasadas: 1, tarefasAtrasadas: 2, perguntasSemResposta: 1 }, cal, "2026-11-06");
    expect(a.map((x) => x.codigo)).toEqual(["nf_atrasada", "ia_sem_resposta", "tarefas", "sem_avanco"]);
    expect(a.find((x) => x.codigo === "tarefas")?.texto).toBe("2 tarefas atrasadas");
  });

  it("semana: segunda-feira e dias corridos", () => {
    expect(segundaDaSemana("2026-11-03")).toBe("2026-11-02");
    expect(segundaDaSemana("2026-11-02")).toBe("2026-11-02");
    expect(segundaDaSemana("2026-11-08")).toBe("2026-11-02");
    expect(diasCorridos("2026-10-30", "2026-11-03")).toBe(4);
  });

  it("semana passada do filtroAPP: abaixo da meta, sem avanço e prioridade sobre o histórico do Omni", () => {
    const sp = (avancoInicio: number | null, avancoFim: number | null, meta: number | null) => ({ semanaPassada: { avancoInicio, avancoFim, meta } });
    expect(codigos(sp(40, 43.2, 5))).toEqual(["abaixo_meta"]);
    expect(alertasDaMissao({ ...base, ...sp(40, 43.2, 5) }, cal, "2026-11-06")[0]?.texto).toBe("Semana passada abaixo da meta (3,2 de 5 p.p.)");
    expect(codigos(sp(40, 45, 5))).toEqual([]);
    expect(alertasDaMissao({ ...base, ...sp(40, 40, 5) }, cal, "2026-11-06").map((x) => x.texto)).toEqual(["Sem avanço na semana passada (40%; meta 5 p.p.)"]);
    expect(codigos(sp(100, 100, null))).toEqual([]); // já em 100%
    // O histórico do Omni diria "sem avanço", mas a semana passada do filtroAPP andou.
    expect(codigos({ avanco: 30, avancoSemanaPassada: 30, ...sp(28, 30, null) })).toEqual([]);
    // Sem avanço no início (missão nova), volta ao histórico do Omni.
    expect(codigos({ avanco: 30, avancoSemanaPassada: 30, ...sp(null, 30, null) })).toEqual(["sem_avanco"]);
  });

  it("custo × avanço: médio acima de 15 p.p., grave acima de 30 ou além de 100% do previsto", () => {
    const g = (consumo: number, avanco: number) => alertasDaMissao({ ...base, custo: { consumo, avanco } }, cal, "2026-11-06").find((x) => x.codigo === "custo")?.gravidade;
    expect(g(60, 45)).toBeUndefined();
    expect(g(61, 45)).toBe("media");
    expect(g(76, 45)).toBe("alta");
    expect(g(101, 100)).toBe("alta");
    expect(alertasDaMissao({ ...base, custo: { consumo: 166, avanco: 34.4 } }, cal, "2026-11-06")[0]?.texto).toBe("Custo em 166% do previsto (avanço 34%)");
    expect(codigos({ custo: { consumo: null, avanco: 40 } })).toEqual([]);
  });

  it("equipamento além da permanência prevista; grave quando há diária de stand-by", () => {
    const eq = { saida: "2026-10-01", retornou: false, permanenciaPrevista: 30, diaria: null };
    expect(codigos({ equipamento: eq }, "2026-10-31")).toEqual([]);
    const a = alertasDaMissao({ ...base, equipamento: eq }, cal, "2026-11-06").find((x) => x.codigo === "equipamento");
    expect(a).toMatchObject({ gravidade: "media", texto: "Equipamento em obra há 36 dias (previsto 30)" });
    const comDiaria = alertasDaMissao({ ...base, equipamento: { ...eq, diaria: 2000 } }, cal, "2026-11-06").find((x) => x.codigo === "equipamento");
    expect(comDiaria?.gravidade).toBe("alta");
    expect(comDiaria?.texto).toMatch(/stand-by R\$\s2\.000\/dia$/);
    expect(codigos({ equipamento: { ...eq, retornou: true } })).toEqual([]);
    expect(codigos({ equipamento: eq, stage: "POST_JOB", avanco: null, avancoSemanaPassada: null })).toEqual([]);
    expect(codigos({ equipamento: { ...eq, diaria: 0 } })).toEqual(["equipamento"]);
  });
});
