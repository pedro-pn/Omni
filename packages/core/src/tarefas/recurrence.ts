export type RecurrenceParseResult = {
  valid: boolean;
  value: string | null;
  label: string;
  message: string;
  startDate?: string;
};

export const recurrenceSuggestions = [
  "Todos os dias",
  "Dias úteis",
  "Toda semana",
  "Toda segunda",
  "Toda segunda e quarta",
  "Toda segunda, quarta e sexta",
  "A cada 15 dias",
  "A cada 2 semanas",
  "Todo dia 10",
  "Todo mês",
  "Todo ano",
];

const weekdayNames = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

const weekdayNumbers: Record<string, number> = {
  domingo: 0,
  dom: 0,
  segunda: 1,
  seg: 1,
  terca: 2,
  ter: 2,
  quarta: 3,
  qua: 3,
  quinta: 4,
  qui: 4,
  sexta: 5,
  sex: 5,
  sabado: 6,
  sab: 6,
};

export function parseRecurrenceInput(input: string): RecurrenceParseResult {
  const raw = input.trim();
  if (!raw || normalize(raw) === "nao repetir") {
    return { valid: true, value: null, label: "Não repetir", message: "A tarefa não se repetirá." };
  }

  const normalized = normalize(raw)
    .replace(/-feira\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/^(daily|weekdays|monthly|yearly)$/.test(normalized)) {
    return success(normalized);
  }
  if (/^weekly:[0-6](?:,[0-6])*$/.test(normalized)) return success(normalized);
  if (/^monthly:(?:[1-9]|[12]\d|3[01])$/.test(normalized)) return success(normalized);
  if (/^interval:[1-9]\d*:(?:days|weeks|months|years)$/.test(normalized))
    return success(normalized);
  if (isMonthlyWeekdayRule(normalized)) return success(normalized);
  const legacyInterval = normalizeLegacyInterval(normalized);
  if (legacyInterval) return success(legacyInterval);

  const dated = normalized.match(
    /^(todo ano|anualmente|toda semana|semanalmente)\s+(?:a partir de\s+)?(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/,
  );
  if (dated) {
    const year = dated[4]!.length === 2 ? 2000 + Number(dated[4]) : Number(dated[4]);
    const startDate = [year, dated[3]!.padStart(2, "0"), dated[2]!.padStart(2, "0")].join("-");
    if (parseDateOnly(startDate)) {
      const rule = /^(todo ano|anualmente)$/.test(dated[1]!) ? "yearly" : "interval:1:weeks";
      return success(rule, startDate);
    }
  }

  const monthDay = normalized.match(/^(?:todo|todos os)\s+dia(?:s)?\s+(\d{1,2})$/);
  if (monthDay) {
    const day = Number(monthDay[1]);
    if (day >= 1 && day <= 31) return success(`monthly:${day}`);
  }

  if (/^(?:todo dia|todos os dias|diariamente)$/.test(normalized)) return success("daily");
  if (/^(?:dias uteis|todo dia util|todos os dias uteis)$/.test(normalized))
    return success("weekdays");
  if (
    /^(?:fim de semana|fins de semana|todo fim de semana|todos os fins de semana)$/.test(normalized)
  )
    return success("weekly:0,6");
  if (/^(?:todo mes|mensalmente)$/.test(normalized)) return success("monthly");
  if (/^(?:todo ano|anualmente)$/.test(normalized)) return success("yearly");
  if (/^(?:toda semana|semanalmente)$/.test(normalized)) return success("interval:1:weeks");
  if (/^quinzenalmente$/.test(normalized)) return success("interval:2:weeks");

  const interval = normalized.match(
    /^(?:a cada|cada)\s+(\d+)\s+(dia|dias|semana|semanas|mes|meses|ano|anos)$/,
  );
  if (interval) {
    const amount = Math.max(1, Math.min(999, Number(interval[1])));
    const units: Record<string, "days" | "weeks" | "months" | "years"> = {
      dia: "days",
      dias: "days",
      semana: "weeks",
      semanas: "weeks",
      mes: "months",
      meses: "months",
      ano: "years",
      anos: "years",
    };
    if (amount === 1 && units[interval[2]!] === "days") return success("daily");
    if (amount === 1 && units[interval[2]!] === "months") return success("monthly");
    if (amount === 1 && units[interval[2]!] === "years") return success("yearly");
    return success(`interval:${amount}:${units[interval[2]!]}`);
  }

  if (/^(?:tod[ao]s?\s+|todos os\s+)?[a-z, e]+$/.test(normalized)) {
    const tokens = normalized.match(
      /domingo|dom|segunda|seg|terca|ter|quarta|qua|quinta|qui|sexta|sex|sabado|sab/g,
    );
    if (tokens?.length) {
      const days = [...new Set(tokens.map((token) => weekdayNumbers[token]!))].sort((a, b) => a - b);
      const residue = normalized
        .replace(/\b(?:todo|toda|todos|todas|os|as|e)\b/g, " ")
        .replace(
          /domingo|dom|segunda|seg|terca|ter|quarta|qua|quinta|qui|sexta|sex|sabado|sab/g,
          " ",
        )
        .replace(/[,\s]+/g, "")
        .trim();
      if (!residue) return success(`weekly:${days.join(",")}`);
    }
  }

  return {
    valid: false,
    value: null,
    label: raw,
    message:
      "Não reconheci essa recorrência. Tente “dias úteis”, “toda segunda e quarta” ou “a cada 15 dias”.",
  };
}

export function formatRecurrence(value: string) {
  value = normalizeLegacyInterval(value) ?? value;
  if (value === "daily") return "Todos os dias";
  if (value === "weekdays") return "Dias úteis";
  if (value === "monthly") return "Todo mês";
  if (value === "yearly") return "Todo ano";
  if (value.startsWith("monthly:")) return `Todo dia ${value.split(":")[1]}`;
  if (value.startsWith("weekly:")) {
    const days = value
      .slice("weekly:".length)
      .split(",")
      .map(Number)
      .filter((day) => day >= 0 && day <= 6)
      .map((day) => weekdayNames[day]!);
    if (!days.length) return "Semanalmente";
    if (days.length === 2 && days.includes("sábado") && days.includes("domingo"))
      return "Todos os fins de semana";
    const joined = joinPtBr(days);
    if (days.length === 1)
      return days[0] === "sábado" || days[0] === "domingo" ? `Todo ${joined}` : `Toda ${joined}`;
    if (days.every((day) => !["sábado", "domingo"].includes(day))) return `Toda ${joined}`;
    return `Toda semana: ${joined}`;
  }
  const interval = value.match(/^interval:([1-9]\d*):(days|weeks|months|years)$/);
  if (interval) {
    const amount = Number(interval[1]);
    if (amount === 1 && interval[2] === "weeks") return "Toda semana";
    const units = {
      days: amount === 1 ? "dia" : "dias",
      weeks: amount === 1 ? "semana" : "semanas",
      months: amount === 1 ? "mês" : "meses",
      years: amount === 1 ? "ano" : "anos",
    } as const;
    return `A cada ${amount} ${units[interval[2] as keyof typeof units]}`;
  }
  if (value === "monthly-last-weekday") return "Último dia útil do mês";
  const business = value.match(/^monthly-business-day:([1-9]|1\d|20)$/);
  if (business) return `${business[1]}º dia útil do mês`;
  const last = value.match(/^monthly-last-weekday-of:([0-6])$/);
  if (last) return `Última ocorrência de ${weekdayNames[Number(last[1])]} do mês`;
  const nth = value.match(/^monthly-nth-weekday:([1-5]):([0-6])$/);
  if (nth) return `${nth[1]}ª ocorrência de ${weekdayNames[Number(nth[2])]} do mês`;
  return "Recorrência não reconhecida";
}

export function nextRecurrenceDate(
  value: string,
  previousDueDate: string | null,
  referenceDate: string,
) {
  value = value.trim();
  const rule = normalizeLegacyInterval(value) ?? value;
  const reference = parseDateOnly(referenceDate);
  if (!reference) return null;

  const previous = previousDueDate ? parseDateOnly(previousDueDate) : null;
  const base = previous && formatDateOnly(previous) > referenceDate ? previous : reference;
  const baseIso = formatDateOnly(base);

  if (rule === "daily") return formatDateOnly(addUtcDays(base, 1));

  if (rule === "weekdays") {
    let candidate = addUtcDays(base, 1);
    while ([0, 6].includes(candidate.getUTCDay())) candidate = addUtcDays(candidate, 1);
    return formatDateOnly(candidate);
  }

  const weekly = rule.match(/^weekly:([0-6](?:,[0-6])*)$/);
  if (weekly) {
    const weekdays = new Set(weekly[1]!.split(",").map(Number));
    for (let delta = 1; delta <= 7; delta += 1) {
      const candidate = addUtcDays(base, delta);
      if (weekdays.has(candidate.getUTCDay())) return formatDateOnly(candidate);
    }
  }

  const interval = rule.match(/^interval:([1-9]\d*):(days|weeks|months|years)$/);
  if (interval) {
    const amount = Math.max(1, Number(interval[1]));
    const unit = interval[2];
    if (unit === "days" || unit === "weeks") {
      const stepDays = amount * (unit === "weeks" ? 7 : 1);
      const anchor = previous ?? reference;
      const elapsedDays = Math.floor((base.getTime() - anchor.getTime()) / 86_400_000);
      const steps = Math.floor(elapsedDays / stepDays) + 1;
      return formatDateOnly(addUtcDays(anchor, steps * stepDays));
    }
    const anchor = previous ?? reference;
    const stepMonths = amount * (unit === "years" ? 12 : 1);
    const elapsedMonths =
      (base.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      base.getUTCMonth() -
      anchor.getUTCMonth();
    let steps = Math.max(1, Math.floor(elapsedMonths / stepMonths));
    let candidate = dateInMonth(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth() + steps * stepMonths,
      anchor.getUTCDate(),
    );
    if (formatDateOnly(candidate) <= baseIso) {
      steps += 1;
      candidate = dateInMonth(
        anchor.getUTCFullYear(),
        anchor.getUTCMonth() + steps * stepMonths,
        anchor.getUTCDate(),
      );
    }
    return formatDateOnly(candidate);
  }

  if (isMonthlyWeekdayRule(rule)) {
    // Scan whole months so absent fifth weekdays skip to the next matching month.
    for (let offset = 0; offset < 24; offset += 1) {
      const first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));
      const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
      let businessCount = 0;
      let match: Date | null = null;
      for (let day = 1; day <= last.getUTCDate(); day += 1) {
        const candidate = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), day));
        const weekday = candidate.getUTCDay();
        if (weekday >= 1 && weekday <= 5) businessCount += 1;
        const parts = rule.split(":");
        if (
          (rule === "monthly-last-weekday" && weekday >= 1 && weekday <= 5) ||
          (parts[0] === "monthly-last-weekday-of" && weekday === Number(parts[1])) ||
          (parts[0] === "monthly-nth-weekday" &&
            weekday === Number(parts[2]) &&
            Math.ceil(day / 7) === Number(parts[1])) ||
          (parts[0] === "monthly-business-day" &&
            weekday >= 1 &&
            weekday <= 5 &&
            businessCount === Number(parts[1]))
        )
          match = candidate;
      }
      if (match && formatDateOnly(match) > baseIso) return formatDateOnly(match);
    }
    return null;
  }

  const monthly = rule.match(/^monthly(?::([1-9]|[12]\d|3[01]))?$/);
  if (monthly) {
    const targetDay = monthly[1]
      ? Math.min(31, Math.max(1, Number(monthly[1])))
      : (previous ?? base).getUTCDate();
    let candidate = dateInMonth(base.getUTCFullYear(), base.getUTCMonth(), targetDay);
    if (formatDateOnly(candidate) <= baseIso) {
      candidate = dateInMonth(base.getUTCFullYear(), base.getUTCMonth() + 1, targetDay);
    }
    return formatDateOnly(candidate);
  }

  if (rule === "yearly") {
    const source = previous ?? base;
    let candidate = dateInMonth(base.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate());
    if (formatDateOnly(candidate) <= baseIso) {
      candidate = dateInMonth(base.getUTCFullYear() + 1, source.getUTCMonth(), source.getUTCDate());
    }
    return formatDateOnly(candidate);
  }

  return null;
}

function isMonthlyWeekdayRule(value: string) {
  return /^(monthly-last-weekday|monthly-last-weekday-of:[0-6]|monthly-nth-weekday:[1-5]:[0-6]|monthly-business-day:([1-9]|1\d|20))$/.test(
    value,
  );
}

function normalizeLegacyInterval(value: string) {
  const match = value.match(/^interval-(days|weeks|months|years):([1-9]\d*)$/);
  if (!match) return null;
  const amount = Number(match[2]);
  return `interval:${amount}:${match[1]}`;
}

function parseDateOnly(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return formatDateOnly(date) === value ? date : null;
}

function formatDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateInMonth(year: number, zeroBasedMonth: number, targetDay: number) {
  const monthStart = new Date(Date.UTC(year, zeroBasedMonth, 1));
  const lastDay = new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), Math.min(targetDay, lastDay)),
  );
}

function success(value: string, startDate?: string): RecurrenceParseResult {
  const label = formatRecurrence(value);
  return {
    valid: true,
    value,
    label,
    startDate,
    message: startDate
      ? `A tarefa será repetida: ${label.toLocaleLowerCase("pt-BR")} a partir de ${startDate.split("-").reverse().join("/")}.`
      : `A tarefa será repetida: ${label.toLocaleLowerCase("pt-BR")}.`,
  };
}

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

function joinPtBr(values: string[]) {
  if (values.length < 2) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} e ${values[1]}`;
  return `${values.slice(0, -1).join(", ")} e ${values.at(-1)}`;
}
