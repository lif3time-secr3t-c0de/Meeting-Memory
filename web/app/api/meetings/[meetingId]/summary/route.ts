import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { runQuery } from "@/lib/server/db";
import { ensureReminderTables, getPromiseStateMap } from "@/lib/server/reminders-repo";
import {
  normalizePromises,
  parseAnyDateToIso,
  type NormalizedPromise,
} from "@/lib/server/promise-utils";

export const runtime = "nodejs";

const TRANSCRIPTS_DIR = path.join(process.cwd(), "tmp", "transcripts");
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ meetingId: string }>;
};

type MeetingRow = {
  meeting_id: string;
  audio_file: string | null;
  text: string | null;
  promises_list: unknown;
  date: Date | string | null;
};

function normalizeDate(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function mergePromiseState(
  promises: NormalizedPromise[],
  stateMap: Map<number, { done: boolean; rescheduled_to: Date | string | null }>,
): NormalizedPromise[] {
  return promises.map((item, index) => {
    const state = stateMap.get(index);
    if (!state) return item;

    const rescheduledTo = state.rescheduled_to
      ? parseAnyDateToIso(state.rescheduled_to)
      : null;

    return {
      ...item,
      done: state.done,
      rescheduled_to: rescheduledTo,
      actual_date: rescheduledTo ?? item.actual_date,
    };
  });
}

export async function GET(_request: Request, context: RouteContext) {
  const { meetingId } = await context.params;
  if (!UUID_REGEX.test(meetingId)) {
    return NextResponse.json({ error: "Invalid meeting id." }, { status: 400 });
  }

  await ensureReminderTables();
  const stateResult = await getPromiseStateMap(meetingId);
  const stateMap = stateResult.map;

  const dbResult = await runQuery<MeetingRow>(
    `
      select
        meeting_id::text,
        audio_file,
        text,
        promises_list,
        date
      from meetings
      where meeting_id = $1
      limit 1
    `,
    [meetingId],
  );

  if (!dbResult.skipped && dbResult.rows.length > 0) {
    const row = dbResult.rows[0];
    const normalizedPromises = mergePromiseState(
      normalizePromises(row.promises_list),
      stateMap,
    );
    return NextResponse.json({
      status: "ready",
      meeting_id: row.meeting_id,
      meeting_timestamp: normalizeDate(row.date),
      transcript_text: row.text ?? "",
      promises_list: normalizedPromises,
      audio_file: row.audio_file,
      audio_download_url: row.audio_file ? `/api/meetings/${meetingId}/audio` : null,
      source: "database",
    });
  }

  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${meetingId}.json`);
  try {
    const raw = await readFile(transcriptPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const normalizedPromises = mergePromiseState(
      normalizePromises(parsed.promises_list),
      stateMap,
    );
    return NextResponse.json({
      status: "ready",
      meeting_id: meetingId,
      meeting_timestamp: normalizeDate(
        typeof parsed.created_at === "string" ? parsed.created_at : null,
      ),
      transcript_text:
        typeof parsed.transcript_text === "string" ? parsed.transcript_text : "",
      promises_list: normalizedPromises,
      audio_file: `tmp/recordings/${meetingId}`,
      audio_download_url: `/api/meetings/${meetingId}/audio`,
      source: "file",
    });
  } catch {
    return NextResponse.json({ error: "Meeting summary not found." }, { status: 404 });
  }
}
