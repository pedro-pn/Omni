import { describe, expect, it } from "vitest";

import { BusinessCalendar } from "../business-calendar.ts";
import { FLUXOS_FORA_DA_AGENDA, FLUXOS_IA, planejarPerguntas, planejarRetomadas, trechoDeChegada, type MissaoParaIA } from "./fluxos.ts";

const cal = new BusinessCalendar();
const sp = (iso: string) => new Date(`${iso}-03:00`);
const missao: MissaoParaIA = {
  id: "m1",
  codigo: "5872",
  titulo: "Missão 5872 - Porto Norte",
  stage: "MOBILIZATION",
  executadaNaSede: false,
  mobilizacaoPlanejada: null,
  mobilizacaoComercial: null,
  mobilizacaoReal: "2026-11-06",
  inicioEmCampo: null,
};

describe("chegada da equipe pelo grupo do WhatsApp", () => {
  it("reconhece as frases do protótipo (sem acento e sem maiúsculas) e ignora o resto", () => {
    for (const t of ["Bom dia pessoal, CHEGAMOS na portaria", "Chegaram todos", "estamos na obra", "Onde descarrega o equipamento?", "o líder já chegou"]) {
      expect(trechoDeChegada(t)).not.toBeNull();
    }
    for (const t of ["Bom dia", "Saímos agora da sede", "chegada prevista amanhã", null, ""]) expect(trechoDeChegada(t)).toBeNull();
    expect(trechoDeChegada(`chegamos ${"x".repeat(300)}`)!.length).toBeLessThanOrEqual(160);
  });

  it("é criada fora da agenda; cita quem escreveu; só alguns pede quem falta e pergunta de novo na data", () => {
    expect(FLUXOS_FORA_DA_AGENDA.has("chegada_grupo")).toBe(true);
    const texto = FLUXOS_IA.chegada_grupo.texto({ missao: { codigo: "5872", titulo: "Missão 5872 - Porto Norte" }, chegada: { autor: "Josinaldo", trecho: "Chegamos na portaria", em: "2026-11-09T10:40:00Z" } });
    expect(texto).toBe("No grupo do WhatsApp, Josinaldo escreveu (09/11 às 07:40): “Chegamos na portaria”. A equipe da Missão 5872 - Porto Norte chegou à obra?");
    const r = planejarRetomadas(
      [{ id: "q1", flow: "chegada_grupo", missaoId: "m1", answer: { opcao: "alguns", nova_data: "2026-11-11" }, answeredAt: sp("2026-11-09T09:00:00"), payload: { missao: { codigo: "5872", titulo: "x" } } }],
      cal,
      sp("2026-11-09T09:00:00"),
    );
    expect(r.map((x) => [x.flow, x.dueAt.toISOString()])).toEqual([["chegada_restante", "2026-11-11T11:00:00.000Z"]]);
    expect(FLUXOS_IA.chegada_grupo.opcoes.find((o) => o.id === "ninguem")!.desvio).toBeDefined();
  });

  it("com a chegada confirmada, a IA não pergunta mais se a equipe começou em campo", () => {
    const agora = sp("2026-11-06T15:00:00");
    expect(planejarPerguntas(missao, [], cal, agora).map((p) => p.flow)).toEqual(["inicio_campo"]);
    expect(planejarPerguntas({ ...missao, chegadaConfirmada: true }, [], cal, agora)).toEqual([]);
  });
});
