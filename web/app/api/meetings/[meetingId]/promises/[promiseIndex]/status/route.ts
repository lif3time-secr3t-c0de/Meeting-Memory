import { NextResponse } from "next/server";
import { ensureReminderTables, markPromiseDone } from "@/lib/server/reminders-repo";

export const runtime = "nodejs";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ meetingId: string; promiseIndex: string }>;
};

type StatusBody = {
  done?: boolean;
};

function parsePromiseIndex(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export async function POST(request: Request, context: RouteContext) {
  const { meetingId, promiseIndex: promiseIndexRaw } = await context.params;
  if (!UUID_REGEX.test(meetingId)) {
    return NextResponse.json({ error: "Invalid meeting id." }, { status: 400 });
  }

  const promiseIndex = parsePromiseIndex(promiseIndexRaw);
  if (promiseIndex === null) {
    return NextResponse.json({ error: "Invalid promise index." }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as StatusBody | null;
  if (!payload || typeof payload.done !== "boolean") {
    return NextResponse.json({ error: "Body must include boolean `done`." }, { status: 400 });
  }

  const reminderTablesReady = await ensureReminderTables();
  if (!reminderTablesReady) {
    return NextResponse.json(
      { error: "Database is not configured. Set DATABASE_URL." },
      { status: 500 },
    );
  }

  const saved = await markPromiseDone(meetingId, promiseIndex, payload.done);
  if (!saved) {
    return NextResponse.json(
      { error: "Could not save promise status." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    status: "ok",
    meeting_id: meetingId,
    promise_index: promiseIndex,
    done: payload.done,
  });
}

