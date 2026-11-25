import {
  findSmartDateHighlight,
  findNamedCommand,
  parseQuickInput,
  type NewTaskInput,
  type SmartProject,
  type SmartSection,
} from "./smart-parse.ts";

export type BatchPerson = { name: string; email: string; nickname?: string | null };
export type BatchTaskDraft = NewTaskInput & {
  sourceLine: number;
  projectHint: string;
  personHint: string;
  assigneeGroup?: number;
};

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchBatchPeople(people: BatchPerson[], query: string) {
  const name = normalize(query.replace(/^[@+]/, ""));
  if (!name) return [];
  const aliases = (person: BatchPerson) =>
    [person.name, person.nickname ?? "", person.email, person.email.split("@")[0]!].map(normalize);
  const exact = people.filter((person) => aliases(person).includes(name));
  return exact.length
    ? exact
    : people.filter((person) =>
        [person.name, person.nickname ?? "", person.email.split("@")[0]!].some((alias) =>
          ` ${normalize(alias)} `.includes(` ${name} `),
        ),
      );
}

function schedule(value: string, today: string, tomorrow: string) {
  const parsed = parseQuickInput(
    value,
    [],
    [],
    [],
    { dueDate: null, priority: 4, projectId: "" },
    today,
    tomorrow,
  );
  // Only consume standalone date expressions, never dates inside the task prose.
  return parsed.dueDate && !parsed.content.trim() ? parsed : null;
}

// Prefer the longest name at each position (Pedro Augusto, not the ambiguous Pedro).
// Keep source offsets so names in prose need not be removed from the task text.
function peopleInText(text: string, people: BatchPerson[]) {
  const words = [...text.matchAll(/[@+]?[\p{L}\d]+(?:[.@_-][\p{L}\d]+)*/gu)];
  const found: {
    start: number;
    end: number;
    name: string;
    people: BatchPerson[];
    explicit: boolean;
  }[] = [];
  for (let index = 0; index < words.length; index++) {
    for (let end = Math.min(index + 10, words.length); end > index; end--) {
      const start = words[index]!.index!;
      const finish = words[end - 1]!.index! + words[end - 1]![0].length;
      const name = text.slice(start, finish);
      const matches = matchBatchPeople(people, name);
      if (!matches.length) continue;
      found.push({ start, end: finish, name, people: matches, explicit: /^[@+]/.test(name) });
      index = end - 1;
      break;
    }
  }
  return found;
}

const bulletPattern = /^(?:[-*•–]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/;

function labeledMetadata(text: string) {
  let person: string | undefined;
  let date: string | undefined;
  const remaining = text
    .replace(
      /(👤|respons[aá]vel\s*:|📅|(?:prazo|data)\s*:)\s*([^|👤📅\n]+)/giu,
      (_, label: string, value: string) => {
        if (label === "👤" || /^respons/i.test(label)) person = value.trim();
        else date = value.trim();
        return "";
      },
    )
    .replace(/\s*\|\s*$/gm, "")
    .trim();
  return { person, date, remaining };
}

function taskBlock(
  lines: string[],
  start: number,
  projects: SmartProject[],
  people: BatchPerson[],
) {
  const continuation: string[] = [];
  let end = start;
  let hasIndentedDescription = false;
  for (let index = start + 1; index < lines.length; index++) {
    const text = lines[index]!.trim();
    if (bulletPattern.test(text)) break;
    const name = text.split(/\s+[-–—]\s+/)[0]!;
    if (
      projects.some((project) => normalize(project.name) === normalize(text)) ||
      matchBatchPeople(people, name).length
    )
      break;
    continuation.push(lines[index]!);
    if (/^\s+\S/.test(lines[index]!)) hasIndentedDescription = true;
    end = index;
    // Labeled metadata terminates a block; the next plain line can be another task.
    const metadata = labeledMetadata(continuation.join("\n"));
    if (metadata.person !== undefined && metadata.date !== undefined) break;
  }
  const metadata = labeledMetadata(continuation.map((line) => line.trim()).join("\n"));
  if (!hasIndentedDescription && metadata.person === undefined && metadata.date === undefined)
    return { end: start, description: "", person: undefined, date: undefined };
  return { end, description: metadata.remaining, person: metadata.person, date: metadata.date };
}

// A project such as "Comercial - Gilmar" is one command, not a person segment.
function protectLocations(
  text: string,
  projects: SmartProject[],
  sections: SmartSection[],
  defaultProjectId: string | null,
) {
  const commands: string[] = [];
  let projectId = defaultProjectId;
  for (const prefix of ["#", "/"]) {
    const choices =
      prefix === "#" ? projects : sections.filter((section) => section.projectId === projectId);
    const aliases = choices.map((value) => ({ value, aliases: [value.name] }));
    let command = findNamedCommand(text, prefix, aliases, true);
    if (prefix === "#" && command) projectId = command.value.id;
    while (command) {
      const token = `\uE000${commands.length}\uE001`;
      commands.push(text.slice(command.index, command.index + command.length));
      text = text.slice(0, command.index) + token + text.slice(command.index + command.length);
      command = findNamedCommand(text, prefix, aliases, true);
    }
  }
  return {
    text,
    restore: (value: string) =>
      value.replace(/\uE000(\d+)\uE001/g, (_, index) => commands[Number(index)] ?? _),
  };
}

export function parseBatchTasks(input: {
  text: string;
  projects: SmartProject[];
  people: BatchPerson[];
  sections?: SmartSection[];
  defaultProjectId: string;
  today: string;
  tomorrow: string;
}) {
  const tasks: BatchTaskDraft[] = [];
  let projectId = input.defaultProjectId || null;
  let projectHint = "";
  let personHint = "";
  let assigneeEmail: string | null = null;
  let assigneeGroup: number | undefined;
  let dueDate: string | null = null;
  let dueTime: string | null = null;
  const warnings: string[] = [];
  const lines = input.text.replace(/&(?:#x20|nbsp);/gi, " ").split(/\r?\n/);
  let consumedThrough = -1;
  for (const [index, raw] of lines.entries()) {
    if (index <= consumedThrough) continue;
    const line = raw
      .trim()
      .replace(/^\*\*(.*?)\*\*$/, "$1")
      .trim();
    if (!line) continue;
    const bullet = line.match(bulletPattern);
    const heading = line
      .replace(/^#+\s*/, "")
      .replace(/:$/, "")
      .trim();
    const projectMatches = input.projects.filter(
      (project) => normalize(project.name) === normalize(heading),
    );
    if (!bullet && projectMatches.length === 1) {
      projectId = projectMatches[0]!.id;
      projectHint = heading;
      personHint = "";
      assigneeEmail = null;
      assigneeGroup = undefined;
      dueDate = null;
      dueTime = null;
      continue;
    }
    const suffix = heading.match(/\s+[-–—]\s+([^\n]*?)$/);
    const date = suffix ? schedule(suffix[1]!, input.today, input.tomorrow) : null;
    const name = date && suffix ? heading.slice(0, suffix.index).trim() : heading;
    const matches = matchBatchPeople(input.people, name);
    const nextLine =
      lines
        .slice(index + 1)
        .find((value) => value.trim())
        ?.trim() ?? "";
    const followedByBullet = bulletPattern.test(nextLine);
    const nextName = nextLine.split(/\s+[-–—]\s+/)[0]!;
    if (
      !bullet &&
      !tasks.length &&
      !personHint &&
      !matches.length &&
      !date &&
      matchBatchPeople(input.people, nextName).length &&
      (heading === heading.toUpperCase() || line.startsWith("#")) &&
      !/[.!?]/.test(heading)
    ) {
      projectId = null;
      projectHint = heading;
      warnings.push(`Projeto “${heading}” não identificado. Escolha o projeto na revisão.`);
      continue;
    }
    if (
      !bullet &&
      (matches.length ||
        (followedByBullet &&
          name.split(/\s+/).length <= 5 &&
          (date || name === name.toUpperCase())))
    ) {
      personHint = name;
      assigneeGroup = index;
      assigneeEmail = matches.length === 1 ? matches[0]!.email : null;
      dueDate = date?.dueDate ?? null;
      dueTime = date?.dueTime ?? null;
      if (matches.length !== 1)
        warnings.push(
          `Linha ${index + 1}: escolha a pessoa para “${name}” (nome não identificado ou ambíguo).`,
        );
      continue;
    }

    const block = bullet ? taskBlock(lines, index, input.projects, input.people) : null;
    if (block) consumedThrough = block.end;
    const inlineMetadata = labeledMetadata(bullet ? bullet[1]!.trim() : line);
    let metadataPerson = block?.person ?? inlineMetadata.person;
    const metadataDate = block?.date ?? inlineMetadata.date;
    let content = inlineMetadata.remaining;
    let missionPrefix = "";
    // Mission | customer | assignee | task: the assignee column takes precedence
    // over people mentioned in the prose. Keep the mission and customer in the title.
    const columns = content.split("|").map((column) => column.trim());
    if (columns.length >= 4 && /^\d+$/.test(columns[0]!) && columns[1]) {
      metadataPerson ??= columns[2];
      missionPrefix = `${columns[0]} | ${columns[1]} | `;
      content = columns.slice(3).join(" | ");
    }
    const locations = protectLocations(content, input.projects, input.sections ?? [], projectId);
    content = locations.text;
    let rowPersonHint = personHint;
    let rowAssignee = assigneeEmail;
    let override: ReturnType<typeof schedule> = null;
    // Metadata separated by dashes or pipes can occur in any position.
    // Non-metadata segments (e.g. equipment lists) remain untouched.
    const parts = content.split(/\s+[-–—]\s+|\s*\|\s*/);
    const explicit = peopleInText(content, input.people).filter((match) => match.explicit);
    const delimited =
      parts.length > 1
        ? parts.flatMap((part) => {
            const matches = matchBatchPeople(input.people, part);
            return matches.length ? [{ name: part, people: matches }] : [];
          })
        : [];
    let candidates: { name: string; people: BatchPerson[] }[] = explicit.length
      ? explicit
      : delimited;
    if (explicit.length) {
      for (const match of [...explicit].reverse())
        content = content.slice(0, match.start) + content.slice(match.end);
    }
    const keptParts: { text: string; separator: string }[] = [];
    const segments = content.split(/(\s+[-–—]\s+|\s*\|\s*)/);
    for (let partIndex = 0; partIndex < segments.length; partIndex += 2) {
      const part = segments[partIndex]!;
      const date = schedule(part.trim(), input.today, input.tomorrow);
      if (date) override = date;
      else if (!delimited.some((match) => match.name === part))
        keptParts.push({ text: part, separator: segments[partIndex - 1] ?? "" });
    }
    content = keptParts
      .map((part, index) => (index ? part.separator : "") + part.text)
      .join("")
      .replace(/^(?:\s*[-–—|]\s*)+|(?:\s*[-–—|]\s*)+$/g, "")
      .trim();
    content = locations.restore(content);

    // Legacy meeting headers keep dates mentioned in prose ("conferir toda
    // quinta-feira"). Independent lines use the same parser as a new task.
    const highlight =
      personHint && bullet && !override
        ? findSmartDateHighlight(content, input.today, input.tomorrow)
        : null;
    const parsed = parseQuickInput(
      content,
      input.projects,
      input.sections ?? [],
      [],
      { dueDate: override?.dueDate ?? dueDate, priority: 4, projectId: projectId ?? "" },
      input.today,
      input.tomorrow,
      highlight ? [content.slice(highlight.start, highlight.end)] : [],
    );
    if (metadataPerson !== undefined) {
      const matches = matchBatchPeople(input.people, metadataPerson);
      candidates = [
        {
          name: metadataPerson,
          people: matches.length
            ? matches
            : peopleInText(metadataPerson, input.people).flatMap((match) => match.people),
        },
      ];
    } else if (!candidates.length && !personHint) {
      candidates = peopleInText(`${parsed.content}\n${block?.description ?? ""}`, input.people);
    }
    if (candidates.length) {
      const emails = new Set(
        candidates.flatMap((match) => match.people.map((person) => person.email)),
      );
      rowPersonHint = [...new Set(candidates.map((match) => match.name))].join(" / ");
      rowAssignee = emails.size === 1 ? [...emails][0]! : null;
      if (!rowAssignee)
        warnings.push(
          `Linha ${index + 1}: responsável não identificado ou há mais de uma pessoa possível (${rowPersonHint}). Escolha o responsável na revisão.`,
        );
    }
    const labeledDate =
      metadataDate !== undefined
        ? parseQuickInput(
            metadataDate,
            [],
            [],
            [],
            { dueDate: null, priority: 4, projectId: "" },
            input.today,
            input.tomorrow,
          )
        : null;
    if (labeledDate && !labeledDate.dueDate)
      warnings.push(
        `Linha ${index + 1}: prazo “${metadataDate}” não identificado. Confira a data na revisão.`,
      );
    tasks.push({
      ...parsed,
      content: missionPrefix + parsed.content,
      description: block?.description || undefined,
      dueDate: labeledDate ? labeledDate.dueDate : parsed.dueDate,
      dueTime: labeledDate
        ? labeledDate.dueTime
        : (parsed.dueTime ??
          (override ? override.dueTime : parsed.dueDate === dueDate ? dueTime : null)),
      recurrence: parsed.recurrence ?? override?.recurrence ?? null,
      projectHint,
      personHint: rowPersonHint,
      assigneeEmail: rowAssignee,
      assigneeGroup: candidates.length ? undefined : assigneeGroup,
      sourceLine: index + 1,
    });
  }
  if (tasks.length > 200) warnings.push("Divida o resumo em lotes de até 200 tarefas.");
  return { tasks, warnings };
}
