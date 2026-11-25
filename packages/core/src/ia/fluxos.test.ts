import { describe, expect, it } from "vitest";

import { BusinessCalendar } from "../business-calendar.ts";
import { cicloEncerradoPeloFiltroApp, FLUXOS_COM_RETOMADA, FLUXOS_IA, planejarPerguntas, planejarRetomadas, type MissaoParaIA, type PerguntaRespondida } from "./fluxos.ts";

const cal = new BusinessCalendar({
  extraHolidays: [{ date: "2026-12-08", name: "Imaculada Conceição", scope: "municipal", city: "Itajaí" }],
});
const sp = (iso: string) => new Date(`${iso}-03:00`);

const missao = (extra: Partial<MissaoParaIA> = {}): MissaoParaIA => ({
  id: "m1",
  codigo: "5872",
  titulo: "Missão 5872 - Porto Norte",
  stage: "PREPARATION",
  executadaNaSede: false,
  mobilizacaoPlanejada: "2026-11-09",
  mobilizacaoComercial: null,
  mobilizacaoReal: null,
  inicioEmCampo: null,
  ...extra,
});

describe("planejarPerguntas", () => {
  it("agenda D-5 e D-1 úteis às 8h, pulando o feriado de Finados", () => {
    const p = planejarPerguntas(missao(), [], cal, sp("2026-10-28T10:00:00"));
    const d5 = p.find((x) => x.flow === "mob_d5")!;
    const d1 = p.find((x) => x.flow === "mob_d1")!;
    // 09/11 (seg): 5 úteis antes = 30/10 (02/11 é Finados); 1 útil antes = 06/11
    expect(d5.dueAt.toISOString()).toBe("2026-10-30T11:00:00.000Z");
    expect(d1.dueAt.toISOString()).toBe("2026-11-06T11:00:00.000Z");
    expect(d1.addressedTo).toEqual({ papel: "LEADER" });
    expect(d1.dedupeKey).toBe("mob_d1:m1:2026-11-09");
  });

  it("não cria pergunta para um dia que já passou", () => {
    const p = planejarPerguntas(missao(), [], cal, sp("2026-11-03T10:00:00"));
    expect(p.map((x) => x.flow)).toEqual(["mob_d1"]);
  });

  it("no próprio dia, fora da janela, envia no próximo horário útil", () => {
    const p = planejarPerguntas(missao(), [], cal, sp("2026-11-06T19:00:00"));
    // D-1 era 06/11 (já passou das 18h): vai para o próximo útil, 09/11 às 8h
    expect(p.find((x) => x.flow === "mob_d1")!.dueAt.toISOString()).toBe("2026-11-09T11:00:00.000Z");
  });

  it("usa a previsão comercial quando não há data planejada", () => {
    const p = planejarPerguntas(missao({ mobilizacaoPlanejada: null, mobilizacaoComercial: "2026-11-16" }), [], cal, sp("2026-10-28T10:00:00"));
    expect(p.find((x) => x.flow === "mob_d1")!.dedupeKey).toBe("mob_d1:m1:2026-11-16");
  });

  it("missão na sede, já mobilizada ou sem data não recebe perguntas de mobilização", () => {
    const agora = sp("2026-10-28T10:00:00");
    expect(planejarPerguntas(missao({ executadaNaSede: true }), [], cal, agora)).toEqual([]);
    expect(planejarPerguntas(missao({ mobilizacaoReal: "2026-10-27" }), [], cal, agora)).toEqual([]);
    expect(planejarPerguntas(missao({ mobilizacaoPlanejada: null }), [], cal, agora)).toEqual([]);
    expect(planejarPerguntas(missao({ stage: "EXECUTION" }), [], cal, agora)).toEqual([]);
  });

  it("pergunta o início em campo no 1º dia útil após a mobilização", () => {
    const p = planejarPerguntas(
      missao({ stage: "MOBILIZATION", mobilizacaoReal: "2026-11-06" }),
      [],
      cal,
      sp("2026-11-06T15:00:00"),
    );
    expect(p).toHaveLength(1);
    expect(p[0]!.flow).toBe("inicio_campo");
    expect(p[0]!.dueAt.toISOString()).toBe("2026-11-09T11:00:00.000Z");
  });

  it("avisa RDO devolvido na última semana", () => {
    const agora = sp("2026-10-28T10:00:00");
    const p = planejarPerguntas(
      missao({ stage: "EXECUTION" }),
      [
        { id: "r1", tipo: "RDO", numero: "82", data: "2026-10-26", status: "RETURNED", devolvidoEm: "2026-10-27T20:00:00.000Z" },
        { id: "r2", tipo: "RDO", numero: "70", data: "2026-10-10", status: "RETURNED", devolvidoEm: "2026-10-12T20:00:00.000Z" },
        { id: "r3", tipo: "RDO", numero: "83", data: "2026-10-27", status: "APPROVED", devolvidoEm: null },
      ],
      cal,
      agora,
    );
    expect(p.map((x) => x.dedupeKey)).toEqual(["rdo_devolvido:r1:2026-10-27T20:00:00.000Z"]);
    expect(p[0]!.dueAt.toISOString()).toBe(agora.toISOString());
  });
});

describe("textos e desvios", () => {
  it("monta a pergunta e a descrição do desvio sem nome fixo", () => {
    const payload = { missao: { codigo: "5872", titulo: "Missão 5872 - Porto Norte" }, dataMobilizacao: "2026-11-09" };
    expect(FLUXOS_IA.mob_d1.texto(payload)).toBe("A mobilização da Missão 5872 - Porto Norte está confirmada para 09/11/2026?");
    const nao = FLUXOS_IA.mob_d1.opcoes.find((o) => o.id === "nao")!;
    expect(nao.pede).toEqual(["nova_data", "motivo"]);
    expect(nao.desvio!(payload, { opcao: "nao", nova_data: "2026-11-11", motivo: "Liberação do cliente", respondidoPor: "Fulano" })).toBe(
      "Missão 5872: mobilização prevista para 09/11/2026 não confirmada. Nova data: 11/11/2026. Motivo: Liberação do cliente Informado por Fulano no Omni.",
    );
  });
});

describe("ciclo depois da execução", () => {
  const emCampo = (extra: Partial<MissaoParaIA> = {}) =>
    missao({ stage: "EXECUTION", mobilizacaoReal: "2026-10-01", inicioEmCampo: "2026-10-02", cobrarRdo: true, ...extra });

  it("cobra o RDO de um dia do regime que não chegou, no dia útil seguinte às 10h", () => {
    // sex 06/11 10h: olha 03, 04 e 05/11; chegaram 03 e 04
    const rdos = ["2026-11-03", "2026-11-04"].map((data, i) => ({
      id: `r${i}`, tipo: "RDO", numero: null, data, status: "PENDING", devolvidoEm: null,
    }));
    const p = planejarPerguntas(emCampo(), rdos, cal, sp("2026-11-06T09:00:00"));
    expect(p.map((x) => x.dedupeKey)).toEqual(["rdo_atrasado:m1:2026-11-05"]);
    expect(p[0]!.dueAt.toISOString()).toBe("2026-11-06T13:00:00.000Z");
  });

  it("sem permissão para cobrar (missão sem RDO, cópia desatualizada ou cobrança aberta), não cobra", () => {
    expect(planejarPerguntas(emCampo({ cobrarRdo: false }), [], cal, sp("2026-11-06T09:00:00"))).toEqual([]);
  });

  it("sábado só conta se o contrato incluir", () => {
    const agora = sp("2026-11-09T09:00:00"); // seg: olha 06 (sex), 07 (sáb) e 08 (dom)
    const rdoSexta = [{ id: "r1", tipo: "RDO", numero: null, data: "2026-11-06", status: "PENDING", devolvidoEm: null }];
    expect(planejarPerguntas(emCampo(), rdoSexta, cal, agora)).toEqual([]);
    const comSabado = planejarPerguntas(emCampo({ trabalhaSabado: true }), rdoSexta, cal, agora);
    expect(comSabado.map((x) => x.dedupeKey)).toEqual(["rdo_atrasado:m1:2026-11-07"]);
  });

  it("desmobilização: véspera útil, equipamentos às 16h do dia e chegada à sede no útil seguinte", () => {
    const p = planejarPerguntas(emCampo({ desmobilizacao: "2026-11-13" }), [], cal, sp("2026-11-10T09:00:00"));
    const por = Object.fromEntries(p.filter((x) => x.flow !== "rdo_atrasado").map((x) => [x.flow, x.dueAt.toISOString()]));
    expect(por).toEqual({
      desmob_d1: "2026-11-12T11:00:00.000Z",
      desmob_equip: "2026-11-13T19:00:00.000Z",
      chegada_sede: "2026-11-16T11:00:00.000Z",
    });
  });

  it("medição vai para a função Medição no fim da operação em campo; missão antiga não é cobrada", () => {
    const fim = missao({ stage: "POST_JOB", fimEmCampo: "2026-11-13" });
    const [m] = planejarPerguntas(fim, [], cal, sp("2026-11-13T15:00:00"));
    expect(m).toMatchObject({ flow: "medicao", addressedTo: { funcao: "medicao" }, payload: { dataCampo: "2026-11-13" } });
    expect(planejarPerguntas(fim, [], cal, sp("2026-12-10T09:00:00"))).toEqual([]);
  });
});

describe("planejarRetomadas", () => {
  const payload = { missao: { codigo: "5872", titulo: "Missão 5872 - Porto Norte" }, dataMobilizacao: "2026-11-09" };
  const resp = (flow: string, answer: PerguntaRespondida["answer"], answeredAt = sp("2026-11-06T09:00:00")): PerguntaRespondida => ({
    id: "q1", flow, missaoId: "m1", answer, answeredAt, payload,
  });

  it("'não' com nova data na mobilização volta a perguntar 1 dia útil antes, com a chave da data", () => {
    const r = planejarRetomadas([resp("mob_d1", { opcao: "nao", nova_data: "2026-11-11" })], cal, sp("2026-11-06T10:00:00"));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ flow: "mob_d1", dedupeKey: "mob_d1:m1:2026-11-11", payload: { dataMobilizacao: "2026-11-11" } });
    expect(r[0]!.dueAt.toISOString()).toBe("2026-11-10T11:00:00.000Z");
  });

  it("'sim', data no passado ou formato inválido não geram retomada", () => {
    const agora = sp("2026-11-06T10:00:00");
    expect(planejarRetomadas([resp("mob_d1", { opcao: "sim" })], cal, agora)).toEqual([]);
    expect(planejarRetomadas([resp("mob_d1", { opcao: "nao", nova_data: "2026-11-01" })], cal, agora)).toEqual([]);
    expect(planejarRetomadas([resp("mob_d1", { opcao: "nao", nova_data: "amanhã" })], cal, agora)).toEqual([]);
  });

  it("medição feita → aprovação na data prevista; aprovada → faturamento já; NF → pagamentos 5 úteis depois", () => {
    const agora = sp("2026-11-06T10:00:00");
    const [aprov] = planejarRetomadas([resp("medicao", { opcao: "feita", nova_data: "2026-11-11" })], cal, agora);
    expect(aprov).toMatchObject({ flow: "aprovacao", addressedTo: { funcao: "medicao" }, dedupeKey: "aprovacao:m1:apos:q1:0" });
    expect(aprov!.dueAt.toISOString()).toBe("2026-11-11T11:00:00.000Z");

    const [fat] = planejarRetomadas([resp("aprovacao", { opcao: "total" })], cal, agora);
    expect(fat).toMatchObject({ flow: "faturamento", addressedTo: { funcao: "faturamento" } });
    expect(fat!.dueAt.toISOString()).toBe(agora.toISOString());

    const [pag] = planejarRetomadas([resp("faturamento", { opcao: "emitida" })], cal, agora);
    expect(pag!.flow).toBe("pagamentos");
    expect(pag!.dueAt.toISOString()).toBe("2026-11-13T11:00:00.000Z");
  });

  it("aprovação com outra medição pede faturamento e agenda a próxima medição", () => {
    const r = planejarRetomadas([resp("aprovacao", { opcao: "outra", nova_data: "2026-12-01" })], cal, sp("2026-11-06T10:00:00"));
    expect(r.map((x) => x.flow)).toEqual(["faturamento", "medicao"]);
  });

  it("resposta antiga não gera faturamento 'agora' de novo", () => {
    expect(planejarRetomadas([resp("aprovacao", { opcao: "total" }, sp("2026-10-01T10:00:00"))], cal, sp("2026-11-06T10:00:00"))).toEqual([]);
  });
});

describe("declaração do ciclo", () => {
  it("toda retomada aponta para um fluxo existente e toda opção com campos tem rótulo", () => {
    for (const f of Object.values(FLUXOS_IA)) {
      for (const o of f.opcoes as Array<(typeof f.opcoes)[number] & { pede?: string[]; rotulos?: Record<string, string>; retomadas?: Array<{ flow: string }> }>) {
        for (const r of o.retomadas ?? []) expect(FLUXOS_IA).toHaveProperty(r.flow);
        for (const c of o.pede ?? []) expect(o.rotulos?.[c], `${f.titulo} › ${o.rotulo} › ${c}`).toBeTruthy();
      }
    }
  });

  it("respostas que viram tarefa: título sem nome de pessoa e prazo coerente com o que a opção pede", () => {
    const p = { missao: { codigo: "5850", titulo: "Missão 5850 - Granel Sul" }, dataReferencia: "2026-10-28", relatorio: { id: "r", tipo: "RDO", numero: "82", data: "2026-10-26" } };
    const rdo = FLUXOS_IA.rdo_atrasado.opcoes.find((o) => o.id === "trabalhou")!;
    expect(rdo.tarefa!.titulo(p)).toBe("Cobrar o RDO de 28/10");
    expect(FLUXOS_IA.rdo_devolvido.opcoes.find((o) => o.id === "vou_cobrar")!.tarefa!.titulo(p)).toBe("Cobrar a correção do RDO nº 82 de 26/10");
    for (const f of Object.values(FLUXOS_IA)) {
      for (const o of f.opcoes as Array<{ tarefa?: { prazo: string }; pede?: string[] }>) {
        if (o.tarefa?.prazo === "nova_data") expect(o.pede).toContain("nova_data");
      }
    }
  });

  it("o ciclo termina em pagamentos e o saldo incompleto marca o gerente comercial", () => {
    expect(FLUXOS_COM_RETOMADA).toContain("pagamentos");
    expect(FLUXOS_IA.pagamentos.opcoes.find((o) => o.id === "concluido")).toMatchObject({ encerraCiclo: true });
    expect(FLUXOS_IA.aprovacao.opcoes.find((o) => o.id === "parcial")).toMatchObject({ marcar: [{ funcao: "gerente_comercial" }] });
  });
});

describe("dados do filtroAPP (Entrega B): pergunta só o que ele não sabe", () => {
  const vazio = { medicao: null, notas: [], romaneios: [], descargas: [], pendencias: null };
  const posCampo = (dados: Partial<import("./fluxos.ts").DadosFiltroApp>, extra: Partial<MissaoParaIA> = {}) =>
    missao({ stage: "FINAL_MEASUREMENT", fimEmCampo: "2026-11-02", mobilizacaoPlanejada: null, dados: { ...vazio, ...dados }, ...extra });
  const fluxos = (m: MissaoParaIA, quando = "2026-11-03T09:00:00") => planejarPerguntas(m, [], cal, sp(quando)).map((p) => p.flow);

  it("medição: pergunta enquanto o filtroAPP não tem; com a medição registrada, não", () => {
    expect(fluxos(posCampo({ medicao: { situacao: "SEM_MEDICAO", enviadaEm: null, aprovadaEm: null, saldoPendente: null } }))).toContain("medicao");
    expect(fluxos(posCampo({ medicao: { situacao: "PREPARADA", enviadaEm: null, aprovadaEm: null, saldoPendente: null } }))).not.toContain("medicao");
  });

  it("medição enviada sem aprovação → pergunta a aprovação 5 dias úteis depois", () => {
    const p = planejarPerguntas(
      posCampo({ medicao: { situacao: "ENVIADA", enviadaEm: "2026-11-03", aprovadaEm: null, saldoPendente: null } }),
      [],
      cal,
      sp("2026-11-03T09:00:00"),
    ).find((x) => x.flow === "aprovacao")!;
    expect(p.dueAt.toISOString()).toBe("2026-11-10T11:00:00.000Z");
  });

  it("aprovada sem NF depois → pergunta da NF; com NF, não; saldo pendente → pergunta do saldo", () => {
    const aprovada = { situacao: "APROVADA" as const, enviadaEm: "2026-11-03", aprovadaEm: "2026-11-05", saldoPendente: true };
    expect(fluxos(posCampo({ medicao: aprovada }), "2026-11-05T09:00:00")).toEqual(expect.arrayContaining(["faturamento", "saldo_medicao"]));
    expect(fluxos(posCampo({ medicao: aprovada, notas: [{ dataEmissao: "2026-11-06" }] }), "2026-11-05T09:00:00")).not.toContain("faturamento");
  });

  it("descarga: romaneio de saída recente sem descarga total; antigo ou já descarregado, não", () => {
    const m = (dados: Partial<import("./fluxos.ts").DadosFiltroApp>) =>
      missao({ stage: "MOBILIZATION", mobilizacaoReal: "2026-11-04", dados: { ...vazio, ...dados } });
    const saida = { id: "r1", tipo: "SAIDA" as const, data: "2026-11-03", emitidoEm: "2026-11-03" };
    const p = planejarPerguntas(m({ romaneios: [saida] }), [], cal, sp("2026-11-03T15:00:00")).filter((x) => x.flow === "descarga");
    expect(p).toHaveLength(1);
    expect(p[0]!).toMatchObject({ dedupeKey: "descarga:m1:r1", payload: { romaneio: { id: "r1", data: "2026-11-03" } } });
    expect(p[0]!.dueAt.toISOString()).toBe("2026-11-04T13:00:00.000Z");
    expect(fluxos(m({ romaneios: [saida], descargas: [{ romaneioId: "r1", tipo: "TOTAL" }] }), "2026-11-03T15:00:00")).not.toContain("descarga");
    expect(fluxos(m({ romaneios: [saida] }), "2026-11-20T09:00:00")).not.toContain("descarga");
    // Dia ideal já passou, mas ainda na janela e sem confirmação: pergunta hoje.
    const atrasada = planejarPerguntas(m({ romaneios: [saida] }), [], cal, sp("2026-11-06T09:30:00")).find((x) => x.flow === "descarga")!;
    expect(atrasada.dueAt.toISOString()).toBe("2026-11-06T13:00:00.000Z");
  });

  it("romaneio de retorno responde 'os equipamentos voltaram?'", () => {
    const m = (romaneios: import("./fluxos.ts").DadosFiltroApp["romaneios"]) =>
      missao({ stage: "DEMOBILIZATION", mobilizacaoReal: "2026-10-01", inicioEmCampo: "2026-10-02", desmobilizacao: "2026-11-13", dados: { ...vazio, romaneios } });
    expect(fluxos(m([]), "2026-11-10T09:00:00")).toContain("desmob_equip");
    expect(fluxos(m([{ id: "v", tipo: "RETORNO", data: "2026-11-12", emitidoEm: "2026-11-12" }]), "2026-11-10T09:00:00")).not.toContain("desmob_equip");
  });

  it("retomada que o filtroAPP já respondeu não é feita; ciclo encerra pelos dados", () => {
    const payload = { missao: { codigo: "5872", titulo: "Missão 5872 - Porto Norte" } };
    const resposta: PerguntaRespondida = { id: "q1", flow: "faturamento", missaoId: "m1", answer: { opcao: "ainda_nao", nova_data: "2026-11-12" }, answeredAt: sp("2026-11-06T09:00:00"), payload };
    const comNota = { ...vazio, notas: [{ dataEmissao: "2026-11-09" }] };
    expect(planejarRetomadas([resposta], cal, sp("2026-11-06T10:00:00"), () => ({ ...vazio }))).toHaveLength(1);
    expect(planejarRetomadas([resposta], cal, sp("2026-11-06T10:00:00"), () => comNota)).toEqual([]);

    const fechada = { stage: "FINAL_MEASUREMENT", fimEmCampo: "2026-11-02", dados: { ...comNota, pendencias: { aPagar: 0, aReceber: 0, confiavel: true } } };
    expect(cicloEncerradoPeloFiltroApp(fechada)).toBe(true);
    expect(cicloEncerradoPeloFiltroApp({ ...fechada, dados: { ...fechada.dados, pendencias: { aPagar: 0, aReceber: 1, confiavel: true } } })).toBe(false);
    expect(cicloEncerradoPeloFiltroApp({ ...fechada, dados: { ...fechada.dados, pendencias: { aPagar: 0, aReceber: 0, confiavel: false } } })).toBe(false);
    expect(cicloEncerradoPeloFiltroApp({ ...fechada, stage: "EXECUTION" })).toBe(false);
  });
});
