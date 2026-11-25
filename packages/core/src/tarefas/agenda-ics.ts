/**
 * Agenda das tarefas em iCalendar (.ics) — porta de `apple-calendar.ts` do Foco
 * (`../foco/foco/src/server/apple-calendar.ts`): um evento por tarefa aberta com
 * data (dia inteiro sem hora; com hora, duração padrão de 30 min), lembrete
 * como alarme, atualização a cada 15 min. O UID é o mesmo do Foco
 * (`foco-<id>@filtrovali.com.br`) para quem já assinava não ver eventos em dobro
 * depois da migração (as tarefas mantêm o id).
 */

export type TarefaAgenda = {
  id: string;
  titulo: string;
  descricao: string | null;
  data: string;
  /** HH:MM ou HH:MM:SS */
  hora: string | null;
  duracaoMinutos: number | null;
  lembreteMinutos: number | null;
  /** Lembrete em horário fixo (tarefas antigas do Foco). */
  lembreteEm: string | null;
  recorrencia: string | null;
  projeto: string | null;
  criadaEm: string;
};

const FUSO = "America/Sao_Paulo";

export function icsEscapar(valor: string): string {
  return valor.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\;").replace(/,/g, "\\,");
}

/** Linhas de no máximo 75 bytes (RFC 5545), sem partir caracteres. */
export function dobrarLinha(linha: string): string {
  const enc = new TextEncoder();
  const partes: string[] = [];
  let atual = "";
  let bytes = 0;
  for (const c of linha) {
    const n = enc.encode(c).length;
    if (bytes + n > 73 && atual) {
      partes.push(atual);
      atual = c;
      bytes = n;
    } else {
      atual += c;
      bytes += n;
    }
  }
  if (atual) partes.push(atual);
  return partes.join("\r\n ");
}

const compacta = (data: string) => data.replaceAll("-", "");
const maisDias = (data: string, dias: number) => {
  const v = new Date(`${data}T12:00:00Z`);
  v.setUTCDate(v.getUTCDate() + dias);
  return v.toISOString().slice(0, 10);
};
function relogio(data: string, hora: string, somar = 0): string {
  const [a, m, d] = data.split("-").map(Number) as [number, number, number];
  const [h, min, s] = hora.split(":").map(Number) as [number, number, number | undefined];
  const v = new Date(Date.UTC(a, m - 1, d, h, min, s || 0));
  v.setUTCMinutes(v.getUTCMinutes() + somar);
  return v.toISOString().replace(/[-:]/g, "").slice(0, 15);
}
const carimbo = (v: Date) => v.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

function minutosDoLembrete(t: TarefaAgenda): number | null {
  if (!t.hora) return null;
  if (t.lembreteMinutos != null) return t.lembreteMinutos;
  if (!t.lembreteEm) return null;
  const hora = t.hora.length === 5 ? `${t.hora}:00` : t.hora;
  const diferenca = Math.round((new Date(`${t.data}T${hora}-03:00`).getTime() - new Date(t.lembreteEm).getTime()) / 60_000);
  return Number.isFinite(diferenca) && diferenca >= 0 && diferenca <= 40_320 ? diferenca : null;
}

function evento(t: TarefaAgenda, app: string, agora: Date): string[] {
  const link = `${app}/?tarefa=${encodeURIComponent(t.id)}`;
  const descricao = [
    t.descricao?.trim() || null,
    t.projeto ? `Projeto: ${t.projeto}` : "Caixa pessoal",
    t.recorrencia ? `Repete no Omni: ${t.recorrencia}` : null,
    `Abrir no Omni: ${link}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const linhas = [
    "BEGIN:VEVENT",
    `UID:foco-${t.id}@filtrovali.com.br`,
    `DTSTAMP:${carimbo(agora)}`,
    `CREATED:${carimbo(new Date(t.criadaEm))}`,
    `SUMMARY:${icsEscapar(t.titulo)}`,
    `DESCRIPTION:${icsEscapar(descricao)}`,
    `URL:${link}`,
    "STATUS:CONFIRMED",
  ];
  if (t.hora) {
    const hora = t.hora.length === 5 ? `${t.hora}:00` : t.hora;
    linhas.push(`DTSTART;TZID=${FUSO}:${relogio(t.data, hora)}`, `DTEND;TZID=${FUSO}:${relogio(t.data, hora, Math.max(t.duracaoMinutos ?? 30, 5))}`);
  } else {
    linhas.push(`DTSTART;VALUE=DATE:${compacta(t.data)}`, `DTEND;VALUE=DATE:${compacta(maisDias(t.data, 1))}`);
  }
  const lembrete = minutosDoLembrete(t);
  if (lembrete != null) linhas.push("BEGIN:VALARM", `TRIGGER:-PT${lembrete}M`, "ACTION:DISPLAY", `DESCRIPTION:${icsEscapar(`Lembrete: ${t.titulo}`)}`, "END:VALARM");
  linhas.push("END:VEVENT");
  return linhas;
}

export function agendaIcs(tarefas: TarefaAgenda[], app: string, agora = new Date()): string {
  const linhas = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Filtrovali//Omni//PT-BR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Omni",
    `X-WR-TIMEZONE:${FUSO}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
    "BEGIN:VTIMEZONE",
    `TZID:${FUSO}`,
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:-0300",
    "TZOFFSETTO:-0300",
    "TZNAME:-03",
    "END:STANDARD",
    "END:VTIMEZONE",
    ...tarefas.flatMap((t) => evento(t, app, agora)),
    "END:VCALENDAR",
  ];
  return `${linhas.map(dobrarLinha).join("\r\n")}\r\n`;
}
