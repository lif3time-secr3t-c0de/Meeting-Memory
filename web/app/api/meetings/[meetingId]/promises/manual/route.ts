import { NextResponse } from "next/server";
import { runQuery } from "@/lib/server/db";
import { normalizePromises, parseIsoDate, toIsoDate } from "@/lib/server/promise-utils";

export const runtime = "nodejs";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ meetingId: string }>;
};

type RequestBody = {
  person?: unknown;
  task?: unknown;
  due_date?: unknown;
};

type MeetingPromisesRow = {
  promises_list: unknown;
};

function normalizePerson(raw: unknown): string {
  if (typeof raw !== "string") return "Speaker";
  const trimmed = raw.trim();
  if (!trimmed) return "Speaker";
  if (trimmed.toLowerCase() === "you") return "Speaker";
  return trimmed;
}

function normalizeTask(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim();
}

function normalizeDueDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = parseIsoDate(trimmed);
  if (!parsed) return null;
  return toIsoDate(parsed);
}

export async function POST(request: Request, context: RouteContext) {
  const { meetingId } = await context.params;
  if (!UUID_REGEX.test(meetingId)) {
    return NextResponse.json({ error: "Invalid meeting id." }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as RequestBody | null;
  const person = normalizePerson(body?.person);
  const task = normalizeTask(body?.task);
  const dueDate = normalizeDueDate(body?.due_date);

  if (!task) {
    return NextResponse.json({ error: "Task is required." }, { status: 400 });
  }

  const meetingResult = await runQuery<MeetingPromisesRow>(
    `
      select promises_list
      from meetings
      where meeting_id = $1
      limit 1
    `,
    [meetingId],
  );

  if (meetingResult.skipped) {
    return NextResponse.json(
      { error: "Database is not configured. Set DATABASE_URL." },
      { status: 500 },
    );
  }

  const row = meetingResult.rows[0];
  if (!row) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }

  const promises = normalizePromises(row.promises_list);
  const addedPromise = {
    person,
    task,
    deadline: dueDate,
    actual_date: dueDate,
  };
  const nextPromises = [...promises, addedPromise];

  const updateResult = await runQuery(
    `
      update meetings
      set promises_list = $2::jsonb
      where meeting_id = $1
    `,
    [meetingId, JSON.stringify(nextPromises)],
  );

  if (updateResult.skipped) {
    return NextResponse.json(
      { error: "Database is not configured. Set DATABASE_URL." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    status: "ok",
    meeting_id: meetingId,
    promise_index: nextPromises.length - 1,
    promise: addedPromise,
  });
}

