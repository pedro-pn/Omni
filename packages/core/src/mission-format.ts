/** Formatação de dados da missão vindos do filtroAPP. */

/** "Seg a sex", "Seg a sáb", "Seg a dom" ou "Seg a sex e dom", a partir do regime do projeto. */
export function regimeTrabalho(includesSaturday: boolean | null, includesSunday: boolean | null): string | null {
  if (includesSaturday === null || includesSunday === null) return null;
  if (includesSaturday && includesSunday) return "Seg a dom";
  if (includesSaturday) return "Seg a sáb";
  if (includesSunday) return "Seg a sex e dom";
  return "Seg a sex";
}

/** Jornada diária do filtroAPP ("HH:MM" de duração): "09:00" → "9h/dia", "08:30" → "8h30/dia". */
export function formatarJornada(hhmm: string | null): string | null {
  const m = hhmm?.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const horas = Number(m[1]);
  const minutos = Number(m[2]);
  return `${horas}h${minutos ? String(minutos).padStart(2, "0") : ""}/dia`;
}

/** 12345678000190 → 12.345.678/0001-90. Outros formatos voltam como vieram. */
/** Telefone só com dígitos (DDI incluído) → "(47) 99999-0000" para o Brasil, "+…" para o resto. */
export function formatarTelefone(t: string | null | undefined): string | null {
  if (!t || !/^\d{8,15}$/.test(t)) return null;
  if (t.startsWith("55") && (t.length === 12 || t.length === 13)) return `(${t.slice(2, 4)}) ${t.slice(4, -4)}-${t.slice(-4)}`;
  return `+${t}`;
}

export function formatarCnpj(cnpj: string | null): string | null {
  if (!cnpj) return null;
  const d = cnpj.replace(/\D/g, "");
  if (d.length !== 14) return cnpj;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

export const PAPEIS_MISSAO = {
  LEADER: "Líder de projetos",
  PLANNER: "Gestor de contrato",
  FIELD_OPERATOR: "Líder de campo",
} as const;

export type PapelMissao = keyof typeof PAPEIS_MISSAO;
