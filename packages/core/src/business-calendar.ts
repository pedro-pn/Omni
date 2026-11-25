import { TZDate } from "@date-fns/tz";

/**
 * Calendário útil da empresa.
 *
 * Regra da IA (INSTRUCOES §7.1): só envia de segunda a sexta, das 08h às 18h,
 * fora de feriados nacionais e municipais de Itajaí. Os feriados nacionais
 * seguem o calendário corporativo do filtroAPP (inclui Carnaval segunda e terça).
 * Feriados municipais e da empresa vêm do banco (tabela `holidays`).
 *
 * Datas civis são strings `AAAA-MM-DD` ("dateKey"); instantes são `Date`.
 * Tudo é calculado no fuso da empresa, independente do fuso do servidor.
 */

export type HolidayScope = "nacional" | "municipal" | "empresa";

export type Holiday = {
  date: string;
  name: string;
  scope: HolidayScope;
  city?: string;
};

export type SendWindow = { startHour: number; endHour: number };

const DAY_MS = 86_400_000;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export const EMPRESA_TIME_ZONE = "America/Sao_Paulo";
export const JANELA_IA: SendWindow = { startHour: 8, endHour: 18 };

function assertDateKey(value: string): void {
  if (!DATE_KEY.test(value)) throw new TypeError(`Data civil inválida: ${value}`);
}

function keyToUtc(key: string): number {
  assertDateKey(key);
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function utcToKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(key: string, days: number): string {
  return utcToKey(keyToUtc(key) + days * DAY_MS);
}

/** 0 = domingo … 6 = sábado. */
export function weekday(key: string): number {
  return new Date(keyToUtc(key)).getUTCDay();
}

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), como no filtroAPP. */
export function easterDate(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcToKey(Date.UTC(year, month - 1, day));
}

/** Mesmas datas de `nationalBrazilHolidays` do filtroAPP. */
export function nationalHolidays(year: number): Holiday[] {
  const easter = easterDate(year);
  const fixed: Array<[string, string]> = [
    ["01-01", "Confraternização Universal"],
    ["04-21", "Tiradentes"],
    ["05-01", "Dia do Trabalho"],
    ["09-07", "Independência do Brasil"],
    ["10-12", "Nossa Senhora Aparecida"],
    ["11-02", "Finados"],
    ["11-15", "Proclamação da República"],
    ["11-20", "Dia da Consciência Negra"],
    ["12-25", "Natal"],
  ];
  const relative: Array<[number, string]> = [
    [-48, "Carnaval"],
    [-47, "Carnaval"],
    [-2, "Paixão de Cristo"],
    [0, "Páscoa"],
    [60, "Corpus Christi"],
  ];
  return [
    ...fixed.map(([suffix, name]) => ({ date: `${year}-${suffix}`, name, scope: "nacional" as const })),
    ...relative.map(([offset, name]) => ({ date: addDays(easter, offset), name, scope: "nacional" as const })),
  ].sort((x, y) => x.date.localeCompare(y.date));
}

export type BusinessCalendarOptions = {
  /** Feriados municipais e da empresa (os nacionais são calculados). */
  extraHolidays?: Holiday[];
  timeZone?: string;
  window?: SendWindow;
};

export class BusinessCalendar {
  readonly timeZone: string;
  readonly window: SendWindow;
  private readonly extra = new Map<string, Holiday>();
  private readonly nationalByYear = new Map<number, Map<string, Holiday>>();

  constructor(options: BusinessCalendarOptions = {}) {
    this.timeZone = options.timeZone ?? EMPRESA_TIME_ZONE;
    this.window = options.window ?? JANELA_IA;
    for (const holiday of options.extraHolidays ?? []) {
      assertDateKey(holiday.date);
      if (!this.extra.has(holiday.date)) this.extra.set(holiday.date, holiday);
    }
  }

  holidayOn(key: string): Holiday | undefined {
    const year = Number(key.slice(0, 4));
    let national = this.nationalByYear.get(year);
    if (!national) {
      national = new Map(nationalHolidays(year).map((h) => [h.date, h]));
      this.nationalByYear.set(year, national);
    }
    return national.get(key) ?? this.extra.get(key);
  }

  isBusinessDay(key: string): boolean {
    const day = weekday(key);
    return day !== 0 && day !== 6 && !this.holidayOn(key);
  }

  /** Data civil, no fuso da empresa, de um instante. */
  dateKeyOf(instant: Date): string {
    const local = new TZDate(instant.getTime(), this.timeZone);
    const y = local.getFullYear();
    const m = String(local.getMonth() + 1).padStart(2, "0");
    const d = String(local.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /** Instante correspondente a `hora:minuto` de uma data civil no fuso da empresa. */
  atLocal(key: string, hour: number, minute = 0): Date {
    const [y, m, d] = key.split("-").map(Number) as [number, number, number];
    return new Date(new TZDate(y, m - 1, d, hour, minute, 0, 0, this.timeZone).getTime());
  }

  businessDayOnOrAfter(key: string): string {
    let current = key;
    while (!this.isBusinessDay(current)) current = addDays(current, 1);
    return current;
  }

  /** N-ésimo dia útil antes de `key` (n = 1 → dia útil anterior). */
  previousBusinessDay(key: string, n = 1): string {
    let current = key;
    let found = 0;
    while (found < n) {
      current = addDays(current, -1);
      if (this.isBusinessDay(current)) found += 1;
    }
    return current;
  }

  /** N-ésimo dia útil depois de `key` (n = 1 → próximo dia útil). */
  nextBusinessDay(key: string, n = 1): string {
    let current = key;
    let found = 0;
    while (found < n) {
      current = addDays(current, 1);
      if (this.isBusinessDay(current)) found += 1;
    }
    return current;
  }

  isWithinWindow(instant: Date): boolean {
    const key = this.dateKeyOf(instant);
    if (!this.isBusinessDay(key)) return false;
    return instant >= this.atLocal(key, this.window.startHour) && instant < this.atLocal(key, this.window.endHour);
  }

  /**
   * Próximo instante em que a IA pode enviar: o próprio instante se estiver
   * dentro da janela; senão, a abertura da janela no próximo dia útil.
   */
  nextSendSlot(instant: Date): Date {
    if (this.isWithinWindow(instant)) return instant;
    const key = this.dateKeyOf(instant);
    if (this.isBusinessDay(key) && instant < this.atLocal(key, this.window.startHour)) {
      return this.atLocal(key, this.window.startHour);
    }
    return this.atLocal(this.nextBusinessDay(key), this.window.startHour);
  }

  /** Feriados entre duas datas (exclusivo nas pontas), para explicar o motivo de uma data. */
  holidaysBetween(fromKey: string, toKey: string): Holiday[] {
    const out: Holiday[] = [];
    for (let current = addDays(fromKey, 1); current < toKey; current = addDays(current, 1)) {
      const holiday = this.holidayOn(current);
      if (holiday) out.push(holiday);
    }
    return out;
  }
}
