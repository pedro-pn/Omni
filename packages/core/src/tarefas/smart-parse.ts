export type SmartProject = { id: string; name: string };
export type SmartMember = { name: string; email: string };
export type SmartSection = { id: string; name: string; projectId: string };

export type NewTaskInput = {
  leaveUnassigned?: boolean;
  sourceTaskId?: string;
  deadline?: string | null;
  durationMinutes?: number | null;
  content: string;
  description?: string;
  projectId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  recurrence: string | null;
  priority: number;
  tag: string | null;
  labels: string[];
  assigneeEmail: string | null;
  sectionId?: string | null;
  parentTaskId?: string | null;
  reminderAt?: string | null;
  reminderOffsetMinutes?: number | null;
};

export type SmartToken = {
  type: "date" | "recurrence" | "project" | "section" | "assignee" | "priority" | "label" | "time";
  label: string;
};

export type SmartDateHighlight = {
  start: number;
  end: number;
  type: "date" | "recurrence";
  label: string;
};

type ParsedDate = {
  match: string;
  dueDate: string;
  recurrence: string | null;
  label: string;
};

const weekdays: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

export function parseQuickInput(
  content: string,
  projects: SmartProject[],
  sections: SmartSection[],
  members: SmartMember[],
  defaults: { dueDate: string | null; priority: number; projectId: string },
  today: string,
  tomorrow: string,
  ignoredDateExpressions: string[] = [],
): NewTaskInput & { detected: SmartToken[] } {
  let clean = content.trim();
  let dueDate = defaults.dueDate;
  let dueTime: string | null = null;
  let recurrence: string | null = null;
  let priority = defaults.priority;
  let projectId: string | null = defaults.projectId || null;
  let sectionId: string | null = null;
  let tag: string | null = null;
  const labels: string[] = [];
  let assigneeEmail: string | null = null;
  const detected: SmartToken[] = [];

  const priorityMatches = Array.from(clean.matchAll(/(?:^|\s)!?p([1-4])(?=\s|$)/gi));
  const priorityMatch = priorityMatches.at(-1);
  if (priorityMatch) {
    priority = Number(priorityMatch[1]);
    detected.push({ type: "priority", label: `P${priority}` });
    for (const match of priorityMatches.reverse())
      clean = removeSlice(clean, match.index ?? 0, match[0].length);
  }

  const projectChoices = projects.map((project) => ({
    value: project,
    aliases: [project.name],
  }));
  let projectCommand = findNamedCommand(clean, "#", projectChoices, true);
  if (projectCommand) {
    projectId = projectCommand.value.id;
    detected.push({ type: "project", label: projectCommand.value.name });
    // Changing a previous choice must not leave the old project controlling the task.
    while (projectCommand) {
      clean = removeSlice(clean, projectCommand.index, projectCommand.length);
      projectCommand = findNamedCommand(clean, "#", projectChoices, true);
    }
  }

  const memberChoices = members.map((member) => ({
    value: member,
    aliases: [member.name, member.name.split(/\s+/)[0]!, member.email, member.email.split("@")[0]!],
  }));
  const memberCommand =
    findNamedCommand(clean, "@", memberChoices) ?? findNamedCommand(clean, "+", memberChoices);
  if (memberCommand) {
    assigneeEmail = memberCommand.value.email;
    detected.push({ type: "assignee", label: memberCommand.value.name });
    clean = removeSlice(clean, memberCommand.index, memberCommand.length);
  }

  const memberAliases = memberChoices
    .flatMap((choice) => choice.aliases)
    .filter(Boolean)
    .map(normalize);
  const labelMatches = Array.from(clean.matchAll(/(?:^|\s)@([\p{L}\d_-]+)(?=\s|$)/gu))
    .filter((match) => {
      const candidate = normalize(match[1]!);
      return !memberAliases.some((alias) => alias.startsWith(candidate));
    })
    .reverse();
  for (const labelMatch of labelMatches) {
    const label = labelMatch[1]!;
    if (
      !labels.some((item) => item.toLocaleLowerCase("pt-BR") === label.toLocaleLowerCase("pt-BR"))
    )
      labels.push(label);
    detected.push({ type: "label", label });
    clean = removeSlice(clean, labelMatch.index ?? 0, labelMatch[0].length);
  }

  const sectionCommand = findNamedCommand(
    clean,
    "/",
    sections
      .filter((section) => section.projectId === projectId)
      .map((section) => ({ value: section, aliases: [section.name] })),
  );
  if (sectionCommand) {
    sectionId = sectionCommand.value.id;
    detected.push({ type: "section", label: sectionCommand.value.name });
    clean = removeSlice(clean, sectionCommand.index, sectionCommand.length);
  }
  labels.reverse();
  tag = labels[0] ?? null;

  // Require a complete time token: never partially consume 8:90 or 8h30min.
  const timeMatch = clean.match(
    /(?:^|\s)(?:(?:às|as|pelas)\s+)?([01]?\d|2[0-3])(?:(?:\s*:\s*|\s*h\s*)([0-5]\d)(?:\s*min(?:utos)?)?|\s+e\s+([0-5]?\d|meia|quinze)(?:\s*min(?:utos)?)?|\s*(?:h|horas?))(?=$|[\s,;!?]|\.(?!\d))/iu,
  ) ?? clean.match(/(?:^|\s)(?:às|as|pelas)\s+([01]?\d|2[0-3])(?=$|[\s,;!?]|\.(?!\d))/iu);
  if (timeMatch) {
    const hour = timeMatch[1]!.padStart(2, "0");
    const rawMinute = timeMatch[2] ?? timeMatch[3] ?? "00";
    const minute = /meia/i.test(rawMinute) ? "30" : /quinze/i.test(rawMinute) ? "15" : rawMinute.padStart(2, "0");
    dueTime = `${hour}:${minute}`;
    detected.push({ type: "time", label: dueTime });
    clean = removeSlice(clean, timeMatch.index ?? 0, timeMatch[0].length);
  }

  const parsedDate = parseNaturalDate(
    maskIgnoredDateExpressions(clean, ignoredDateExpressions),
    today,
    tomorrow,
    dueDate,
  );
  if (parsedDate) {
    dueDate = parsedDate.dueDate;
    recurrence = parsedDate.recurrence;
    detected.push({
      type: parsedDate.recurrence ? "recurrence" : "date",
      label: parsedDate.label,
    });
    const normalizedClean = normalize(clean);
    const normalizedMatch = normalize(parsedDate.match);
    const index = normalizedClean.indexOf(normalizedMatch);
    if (index >= 0) clean = removeSlice(clean, index, parsedDate.match.length);
  }

  return {
    content: clean
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;!?])/g, "$1")
      .trim(),
    projectId,
    dueDate,
    dueTime,
    recurrence,
    priority,
    tag,
    labels,
    assigneeEmail,
    sectionId,
    detected,
  };
}

export function findSmartDateHighlight(
  content: string,
  today: string,
  tomorrow: string,
  ignoredDateExpressions: string[] = [],
): SmartDateHighlight | null {
  const maskedContent = maskIgnoredDateExpressions(content, ignoredDateExpressions);
  const parsedDate = parseNaturalDate(maskedContent, today, tomorrow);
  if (!parsedDate) return null;

  const source = normalizeWithSourceMap(maskedContent);
  const normalizedStart = source.value.indexOf(parsedDate.match);
  if (normalizedStart < 0) return null;

  const normalizedEnd = normalizedStart + parsedDate.match.length - 1;
  return {
    start: source.starts[normalizedStart]!,
    end: source.ends[normalizedEnd]!,
    type: parsedDate.recurrence ? "recurrence" : "date",
    label: parsedDate.label,
  };
}

export function retainPresentIgnoredDateExpressions(content: string, ignoredExpressions: string[]) {
  if (!ignoredExpressions.length) return ignoredExpressions;
  const normalizedContent = normalize(content);
  return ignoredExpressions.filter((expression) => {
    const normalizedExpression = normalize(expression).trim();
    return Boolean(normalizedExpression && normalizedContent.includes(normalizedExpression));
  });
}

function maskIgnoredDateExpressions(content: string, ignoredExpressions: string[]) {
  if (!ignoredExpressions.length) return content;

  const source = normalizeWithSourceMap(content);
  const masked = content.split("");
  const searchOffsets = new Map<string, number>();

  for (const expression of ignoredExpressions) {
    const normalizedExpression = normalize(expression).trim();
    if (!normalizedExpression) continue;
    const from = searchOffsets.get(normalizedExpression) ?? 0;
    const normalizedStart = source.value.indexOf(normalizedExpression, from);
    if (normalizedStart < 0) continue;
    const normalizedEnd = normalizedStart + normalizedExpression.length - 1;
    const sourceStart = source.starts[normalizedStart]!;
    const sourceEnd = source.ends[normalizedEnd]!;
    for (let index = sourceStart; index < sourceEnd; index += 1) masked[index] = " ";
    searchOffsets.set(normalizedExpression, normalizedStart + normalizedExpression.length);
  }

  return masked.join("");
}

function parseNaturalDate(
  content: string,
  today: string,
  tomorrow: string,
  selectedDate: string | null = null,
): ParsedDate | null {
  const normalized = normalize(content);
  const base = fromIso(today);
  const recurrenceBase = selectedDate ? fromIso(selectedDate) : base;
  const datedRecurrence = normalized.match(
    /\b(todo\s+ano|anualmente|toda\s+semana|semanalmente)\s+(?:a\s+partir\s+de\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/,
  );
  if (datedRecurrence) {
    const date = numericDate(
      Number(datedRecurrence[2]),
      Number(datedRecurrence[3]),
      datedRecurrence[4],
      base,
    );
    if (date) {
      const yearly = /^(?:todo\s+ano|anualmente)$/.test(datedRecurrence[1]!);
      return result(
        datedRecurrence[0],
        date,
        yearly ? "yearly" : "interval:1:weeks",
        `${yearly ? "Todo ano" : "Toda semana"} a partir de ${date.toLocaleDateString("pt-BR")}`,
      );
    }
  }
  const recurringDay = normalized.match(/\btodo\s+dia\s+(\d{1,2})\b/);
  if (recurringDay) {
    const day = Math.min(31, Math.max(1, Number(recurringDay[1])));
    return result(
      recurringDay[0],
      nextMonthDay(recurrenceBase, day),
      `monthly:${day}`,
      `Todo dia ${day}`,
    );
  }

  const usefulDays = normalized.match(
    /\b(?:todo\s+dia\s+util|todos\s+os\s+dias\s+uteis|dias\s+uteis)\b/,
  );
  if (usefulDays)
    return result(
      usefulDays[0],
      nextUsefulDay(recurrenceBase, true),
      "weekdays",
      "Todos os dias úteis",
    );

  const everyWeekday = normalized.match(
    /\btod[ao]\s+(segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:[- ]feira)?\b/,
  );
  if (everyWeekday) {
    const weekday = weekdays[everyWeekday[1]!]!;
    return result(
      everyWeekday[0],
      nextWeekday(recurrenceBase, weekday, false),
      `weekly:${weekday}`,
      `Toda ${capitalize(everyWeekday[1]!)}`,
    );
  }

  const daily = normalized.match(/\b(?:todo\s+dia|todos\s+os\s+dias|diariamente)\b/);
  if (daily) return result(daily[0], recurrenceBase, "daily", "Todos os dias");

  const monthly = normalized.match(/\b(?:todo\s+mes|mensalmente)\b/);
  if (monthly) return result(monthly[0], recurrenceBase, "monthly", "Todo mês");

  const yearly = normalized.match(/\b(?:todo\s+ano|anualmente)\b/);
  if (yearly) return result(yearly[0], recurrenceBase, "yearly", "Todo ano");

  const weekly = normalized.match(/\b(?:toda\s+semana|semanalmente)\b/);
  if (weekly) return result(weekly[0], recurrenceBase, "interval:1:weeks", "Toda semana");

  const nextWeek = normalized.match(
    /\bproxim[ao]\s+(segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:[- ]feira)?\b/,
  );
  if (nextWeek)
    return result(
      nextWeek[0],
      nextWeekday(base, weekdays[nextWeek[1]!]!, true),
      null,
      `Próxima ${capitalize(nextWeek[1]!)}`,
    );

  const afterTomorrow = normalized.match(/\bdepois\s+de\s+amanha\b/);
  if (afterTomorrow) return result(afterTomorrow[0], addDays(base, 2), null, "Depois de amanhã");

  const tomorrowMatch = normalized.match(/\bamanha\b/);
  if (tomorrowMatch) return result(tomorrowMatch[0], fromIso(tomorrow), null, "Amanhã");

  const todayMatch = normalized.match(/\bhoje\b/);
  if (todayMatch) return result(todayMatch[0], base, null, "Hoje");

  const explicitDate = normalized.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (explicitDate) {
    const date = numericDate(
      Number(explicitDate[1]),
      Number(explicitDate[2]),
      explicitDate[3],
      base,
    );
    if (date) return result(explicitDate[0], date, null, formatShortDate(date));
  }

  const dayOfMonth = normalized.match(/\bdia\s+(\d{1,2})\b/);
  if (dayOfMonth) {
    const day = Math.min(31, Math.max(1, Number(dayOfMonth[1])));
    return result(dayOfMonth[0], nextMonthDay(base, day), null, `Dia ${day}`);
  }

  const weekday = normalized.match(
    /\b(segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:[- ]feira)?\b/,
  );
  if (weekday)
    return result(
      weekday[0],
      nextWeekday(base, weekdays[weekday[1]!]!, true),
      null,
      capitalize(weekday[1]!),
    );

  return null;
}

export function findNamedCommand<T>(
  content: string,
  prefix: string,
  choices: Array<{ value: T; aliases: string[] }>,
  latest = false,
): { value: T; index: number; length: number } | null {
  const normalized = normalize(content);
  const candidates = choices
    .flatMap((choice) =>
      choice.aliases
        .filter(Boolean)
        .map((alias) => ({ value: choice.value, alias: normalize(alias) })),
    )
    .sort((a, b) => b.alias.length - a.alias.length);

  let found: { value: T; index: number; length: number } | null = null;
  for (const candidate of candidates) {
    const needle = `${prefix}${candidate.alias}`;
    let index = normalized.indexOf(needle);
    while (index >= 0) {
      const before = index === 0 ? " " : normalized[index - 1]!;
      const after = normalized[index + needle.length] ?? " ";
      if (/\s/.test(before) && /[\s,.;!?]/.test(after)) {
        const matchingValues = new Set(
          candidates.filter((item) => item.alias === candidate.alias).map((item) => item.value),
        );
        // Nomes curtos como "+Pedro" não podem escolher arbitrariamente entre
        // duas pessoas. Nesse caso o usuário precisa selecionar uma sugestão
        // inequívoca (nome completo ou identificador do e-mail).
        if (matchingValues.size > 1) return null;
        const match = { value: candidate.value, index, length: needle.length };
        if (!latest) return match;
        if (!found || index > found.index) found = match;
      }
      index = normalized.indexOf(needle, index + 1);
    }
  }
  return found;
}

function result(match: string, date: Date, recurrence: string | null, label: string): ParsedDate {
  return { match, dueDate: localIsoDate(date), recurrence, label };
}

function nextWeekday(base: Date, target: number, strict: boolean) {
  let difference = (target - base.getDay() + 7) % 7;
  if (strict && difference === 0) difference = 7;
  return addDays(base, difference);
}

function nextUsefulDay(base: Date, includeToday: boolean) {
  let next = includeToday ? new Date(base) : addDays(base, 1);
  while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, 1);
  return next;
}

function nextMonthDay(base: Date, day: number) {
  let year = base.getFullYear();
  let month = base.getMonth();
  let date = safeDate(year, month, day);
  if (date < startOfDay(base)) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    date = safeDate(year, month, day);
  }
  return date;
}

function numericDate(day: number, month: number, yearText: string | undefined, base: Date) {
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  let year = yearText ? Number(yearText) : base.getFullYear();
  if (year < 100) year += 2000;
  let date = safeDate(year, month - 1, day);
  if (!yearText && date < startOfDay(base)) date = safeDate(year + 1, month - 1, day);
  return date;
}

function safeDate(year: number, month: number, day: number) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay), 12, 0, 0, 0);
}

function fromIso(value: string) {
  return new Date(`${value}T12:00:00`);
}
function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}
function addDays(value: Date, amount: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + amount);
  return next;
}
function localIsoDate(value: Date) {
  const offset = value.getTimezoneOffset();
  return new Date(value.getTime() - offset * 60000).toISOString().slice(0, 10);
}
function formatShortDate(value: Date) {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" })
    .format(value)
    .replace(".", "");
}
function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

function normalizeWithSourceMap(value: string) {
  let normalizedValue = "";
  const starts: number[] = [];
  const ends: number[] = [];

  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const sourceCharacter = String.fromCodePoint(codePoint);
    const normalizedCharacter = normalize(sourceCharacter);
    normalizedValue += normalizedCharacter;
    for (
      let normalizedIndex = 0;
      normalizedIndex < normalizedCharacter.length;
      normalizedIndex += 1
    ) {
      starts.push(index);
      ends.push(index + sourceCharacter.length);
    }
    index += sourceCharacter.length;
  }

  return { value: normalizedValue, starts, ends };
}
function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function removeSlice(value: string, index: number, length: number) {
  return `${value.slice(0, index)} ${value.slice(index + length)}`;
}
