export type NormalizedPromise = {
  person: string;
  task: string;
  deadline: string | null;
  actual_date: string | null;
  done?: boolean;
  rescheduled_to?: string | null;
};

export function normalizePromise(raw: unknown): NormalizedPromise | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;

  const person =
    typeof item.person === "string"
      ? item.person
      : typeof item.owner === "string"
        ? item.owner
        : "Unknown";

  const task = typeof item.task === "string" ? item.task : "";
  if (!task) return null;

  const deadline =
    typeof item.deadline === "string"
      ? item.deadline
      : typeof item.due_phrase === "string"
        ? item.due_phrase
        : null;

  const actualDate =
    typeof item.actual_date === "string"
      ? item.actual_date
      : typeof item.due_date === "string"
        ? item.due_date
        : null;

  const done = typeof item.done === "boolean" ? item.done : undefined;
  const rescheduledTo =
    typeof item.rescheduled_to === "string" ? item.rescheduled_to : undefined;

  return {
    person,
    task,
    deadline,
    actual_date: actualDate,
    done,
    rescheduled_to: rescheduledTo,
  };
}

export function normalizePromises(raw: unknown): NormalizedPromise[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizePromise(entry))
    .filter((entry): entry is NormalizedPromise => Boolean(entry));
}

export function toIsoDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = (value.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = value.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseIsoDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const parsed = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function parseAnyDateToIso(value: Date | string | null | undefined): string {
  if (!value) return toIsoDate(new Date());
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return toIsoDate(new Date());
  return toIsoDate(parsed);
}
