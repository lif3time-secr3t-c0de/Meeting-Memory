const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const ACTION_VERB_REGEX =
  /\b(send|do|make|update|check|create|finish|review|share|prepare|call|email|draft|fix|deliver|design)\b/i;

const FUTURE_HINT_REGEX =
  /\b(will|i'll|we'll|going to|tomorrow|next week|next month|by\s+[a-z0-9/]+|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

const DEADLINE_REGEX =
  /\b(by\s+(?:tomorrow|next week|next month|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)|tomorrow|next week|next month|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i;

const GENERIC_TASKS = new Set(["do that", "do it", "handle it"]);

export type ExtractedActionItem = {
  person: string;
  task: string;
  deadline: string | null;
  actual_date: string | null;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitSentences(transcript: string): string[] {
  return transcript
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter((sentence) => sentence.length > 0);
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysFromWeekday(baseDate: Date, targetWeekday: number, useNextWord: boolean): number {
  let daysAhead = (targetWeekday - baseDate.getDay() + 7) % 7;
  if (daysAhead === 0) daysAhead = 7;
  if (useNextWord) daysAhead += 7;
  return daysAhead;
}

function toTitleCase(input: string): string {
  return input
    .split(" ")
    .map((part) =>
      part.length === 0 ? part : part[0].toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join(" ");
}

function normalizeDeadlinePhrase(rawPhrase: string | null): string | null {
  if (!rawPhrase) return null;

  let phrase = normalizeWhitespace(rawPhrase);
  phrase = phrase.replace(/^by\s+/i, "");
  phrase = phrase.replace(/^on\s+/i, "");
  phrase = normalizeWhitespace(phrase);

  const lower = phrase.toLowerCase();
  if (lower === "tomorrow" || lower === "next week" || lower === "next month") {
    return lower;
  }

  if (/^(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(phrase)) {
    return toTitleCase(phrase);
  }

  return phrase;
}

function parseActualDate(deadline: string | null, referenceDate: Date): string | null {
  if (!deadline) return null;

  const normalized = deadline.toLowerCase();
  const base = new Date(referenceDate);
  base.setHours(12, 0, 0, 0);

  if (normalized === "tomorrow") {
    const date = new Date(base);
    date.setDate(date.getDate() + 1);
    return localIsoDate(date);
  }

  if (normalized === "next week") {
    const date = new Date(base);
    date.setDate(date.getDate() + 7);
    return localIsoDate(date);
  }

  if (normalized === "next month") {
    const date = new Date(base);
    date.setMonth(date.getMonth() + 1);
    return localIsoDate(date);
  }

  const weekdayMatch = normalized.match(
    /^(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/,
  );
  if (weekdayMatch) {
    const targetIndex = WEEKDAY_INDEX[weekdayMatch[2]];
    const useNextWord = Boolean(weekdayMatch[1]);
    const daysAhead = daysFromWeekday(base, targetIndex, useNextWord);
    const date = new Date(base);
    date.setDate(date.getDate() + daysAhead);
    return localIsoDate(date);
  }

  const explicitDate = normalized.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (explicitDate) {
    const month = Number.parseInt(explicitDate[1], 10);
    const day = Number.parseInt(explicitDate[2], 10);
    const yearToken = explicitDate[3];
    let year = base.getFullYear();

    if (yearToken) {
      const parsed = Number.parseInt(yearToken, 10);
      year = yearToken.length === 2 ? 2000 + parsed : parsed;
    }

    const candidate = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (Number.isNaN(candidate.getTime())) return null;

    if (!yearToken && candidate.getTime() < base.getTime()) {
      candidate.setFullYear(candidate.getFullYear() + 1);
    }

    return localIsoDate(candidate);
  }

  return null;
}

function extractPerson(sentence: string): string {
  const addressedMatch = sentence.match(/^\s*([A-Z][a-z]+)\s*,\s*can you\b/);
  if (addressedMatch) return addressedMatch[1];

  const namedMatch = sentence.match(
    /\b([A-Z][a-z]+)\s+(?:will|is going to|can you|should)\b/,
  );
  if (namedMatch) return namedMatch[1];

  if (/\bwe\s+(?:will|'ll|are going to)\b/i.test(sentence)) return "We";
  if (/\bi\s+(?:will|'ll|am going to)\b/i.test(sentence)) return "Speaker";

  return "Unknown";
}

function trimTask(rawTask: string): string {
  let task = normalizeWhitespace(rawTask);
  task = task.replace(/^to\s+/i, "");
  task = task.replace(/[.?!,:;]+$/g, "");
  task = task.replace(/^([a-z]+)\s+(?:the|a|an)\s+/i, "$1 ");
  return normalizeWhitespace(task);
}

function extractTask(sentence: string): string | null {
  const canYouMatch = sentence.match(
    /(?:\b[A-Z][a-z]+\s*,\s*)?can you\s+(.+?)(?=(?:\s+(?:by|on)\s+[A-Za-z0-9/ ]+|\s+tomorrow|\s+next week|\s+next month|[.?!]|$))/i,
  );
  if (canYouMatch) {
    const task = trimTask(canYouMatch[1]);
    if (task.length >= 3) return task;
  }

  const futureMatch = sentence.match(
    /\b(?:i|we|[A-Z][a-z]+)\s+(?:will|'ll|am going to|are going to|is going to)\s+(.+?)(?=(?:\s+(?:by|on)\s+[A-Za-z0-9/ ]+|\s+tomorrow|\s+next week|\s+next month|[.?!]|$))/i,
  );
  if (futureMatch) {
    const task = trimTask(futureMatch[1]);
    if (task.length >= 3) return task;
  }

  const actionMatch = sentence.match(
    /\b(send|do|make|update|check|create|finish|review|share|prepare|call|email|draft|fix|deliver|design)\b(.+?)(?=(?:\s+(?:by|on)\s+[A-Za-z0-9/ ]+|\s+tomorrow|\s+next week|\s+next month|[.?!]|$))/i,
  );
  if (actionMatch) {
    const task = trimTask(`${actionMatch[1]}${actionMatch[2]}`);
    if (task.length >= 3) return task;
  }

  return null;
}

function extractDeadline(sentence: string): string | null {
  const dueMatch = sentence.match(DEADLINE_REGEX);
  if (!dueMatch) return null;
  const raw = normalizeWhitespace(dueMatch[1] ?? dueMatch[0] ?? "");
  return normalizeDeadlinePhrase(raw);
}

function isActionableSentence(sentence: string): boolean {
  const hasFuture = FUTURE_HINT_REGEX.test(sentence) || /\bcan you\b/i.test(sentence);
  const hasAction = ACTION_VERB_REGEX.test(sentence);
  return hasFuture && hasAction;
}

export function extractActionItems(
  transcriptText: string,
  referenceDate: Date = new Date(),
): ExtractedActionItem[] {
  const sentences = splitSentences(transcriptText);
  const items: ExtractedActionItem[] = [];
  const dedupe = new Set<string>();

  for (const sentence of sentences) {
    if (!isActionableSentence(sentence)) continue;

    const person = extractPerson(sentence);
    const task = extractTask(sentence);
    if (!task) continue;

    const normalizedTask = task.toLowerCase();
    if (GENERIC_TASKS.has(normalizedTask) && person === "Unknown") continue;

    const deadline = extractDeadline(sentence);
    const actualDate = parseActualDate(deadline, referenceDate);
    const dedupeKey = `${person.toLowerCase()}|${normalizedTask}|${(actualDate ?? deadline ?? "").toLowerCase()}`;
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);

    items.push({
      person,
      task,
      deadline,
      actual_date: actualDate,
    });
  }

  return items;
}
