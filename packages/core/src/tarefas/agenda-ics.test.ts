import { describe, expect, it } from "vitest";

import { agendaIcs, dobrarLinha, icsEscapar, type TarefaAgenda } from "./agenda-ics.ts";

const base: TarefaAgenda = { id: "11111111-1111-4111-8111-111111111111", titulo: "Ligar, cliente; urgente", descricao: null, data: "2026-11-12", hora: null, duracaoMinutos: null, lembreteMinutos: null, lembreteEm: null, recorrencia: null, projeto: null, criadaEm: "2026-11-01T12:00:00Z" };
const agora = new Date("2026-11-10T15:00:00Z");

describe("agenda .ics (porta do Foco)", () => {
  it("dia inteiro sem hora; UID igual ao do Foco; texto escapado", () => {
    const ics = agendaIcs([base], "https://omni.filtrovali.com.br", agora);
    expect(ics).toContain("UID:foco-11111111-1111-4111-8111-111111111111@filtrovali.com.br");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261112\r\nDTEND;VALUE=DATE:20261113");
    expect(ics).toContain("SUMMARY:Ligar\\, cliente\; urgente");
    expect(ics).toContain("X-WR-CALNAME:Omni");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("com hora: 30 min por padrão no fuso de São Paulo e lembrete como alarme", () => {
    const ics = agendaIcs([{ ...base, hora: "14:30", lembreteMinutos: 15 }], "https://x", agora);
    expect(ics).toContain("DTSTART;TZID=America/Sao_Paulo:20261112T143000");
    expect(ics).toContain("DTEND;TZID=America/Sao_Paulo:20261112T150000");
    expect(ics).toContain("TRIGGER:-PT15M");
  });

  it("lembrete em horário fixo (do Foco) vira antecedência; linhas longas dobradas sem partir acentos", () => {
    const ics = agendaIcs([{ ...base, hora: "10:00", lembreteEm: "2026-11-12T12:30:00Z" }], "https://x", agora);
    expect(ics).toContain("TRIGGER:-PT30M");
    const longa = dobrarLinha(`DESCRIPTION:${"ação ".repeat(40)}`);
    for (const linha of longa.split("\r\n")) expect(new TextEncoder().encode(linha).length).toBeLessThanOrEqual(75);
    expect(icsEscapar("a\nb")).toBe("a\\nb");
  });
});
