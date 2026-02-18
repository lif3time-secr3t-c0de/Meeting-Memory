import { NextResponse } from "next/server";
import { listMeetingsForEmail } from "@/lib/server/meetings-repo";
import { verifyMeetingInboxToken } from "@/lib/server/reminder-token";
import { ensureReminderTables } from "@/lib/server/reminders-repo";

export const runtime = "nodejs";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseLimit(value: string | null): number {
  if (!value) return 50;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.max(1, Math.min(parsed, 200));
}

function normalizeDate(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function resolveInboxEmail(url: URL): string | null {
  const token = url.searchParams.get("token")?.trim();
  if (token) {
    const payload = verifyMeetingInboxToken(token);
    if (!payload) return null;
    return payload.email;
  }

  const email = url.searchParams.get("email")?.trim().toLowerCase() ?? "";
  if (!EMAIL_REGEX.test(email)) return null;
  return email;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const inboxEmail = resolveInboxEmail(url);
  if (!inboxEmail) {
    return NextResponse.json(
      { error: "Valid token or email is required." },
      { status: 400 },
    );
  }

  const reminderTablesReady = await ensureReminderTables();
  if (!reminderTablesReady) {
    return NextResponse.json(
      { error: "Database is not configured. Set DATABASE_URL." },
      { status: 500 },
    );
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  const result = await listMeetingsForEmail(inboxEmail, limit);
  if (result.skipped) {
    return NextResponse.json(
      { error: "Database is not configured. Set DATABASE_URL." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    status: "ok",
    email: inboxEmail,
    meetings: result.rows.map((row) => {
      const promiseCount = Number.isFinite(row.promise_count)
        ? row.promise_count
        : 0;
      const doneCount = Number.isFinite(row.done_count) ? row.done_count : 0;
      const openCount = Math.max(0, promiseCount - doneCount);
      return {
        meeting_id: row.meeting_id,
        meeting_timestamp: normalizeDate(row.date),
        processing_status: row.processing_status,
        error_message: row.error_message,
        promise_count: promiseCount,
        done_count: doneCount,
        open_count: openCount,
      };
    }),
  });
}

