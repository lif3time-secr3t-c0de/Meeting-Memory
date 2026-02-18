import { NextResponse } from "next/server";
import { runQuery } from "@/lib/server/db";
import {
  enqueueProcessingJob,
  ensureProcessingQueueTable,
  getProcessingJobForMeeting,
} from "@/lib/server/processing-queue-repo";

export const runtime = "nodejs";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ meetingId: string }>;
};

type QueueBody = {
  model?: unknown;
};

type MeetingStatusRow = {
  processing_status: string;
  error_message: string | null;
};

function normalizeModel(value: unknown): "tiny" | "base" {
  if (value === "tiny") return "tiny";
  return "base";
}

export async function POST(request: Request, context: RouteContext) {
  const { meetingId } = await context.params;
  if (!UUID_REGEX.test(meetingId)) {
    return NextResponse.json({ error: "Invalid meeting id." }, { status: 400 });
  }

  const queueReady = await ensureProcessingQueueTable();
  if (!queueReady) {
    return NextResponse.json(
      { error: "Database is not configured. Set DATABASE_URL." },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => null)) as QueueBody | null;
  const model = normalizeModel(body?.model);
  const enqueued = await enqueueProcessingJob(meetingId, model);
  if (enqueued.skipped) {
    return NextResponse.json(
      { error: "Database is not configured. Set DATABASE_URL." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    status: "queued",
    meeting_id: meetingId,
    model,
    message: "Queued for processing.",
  });
}

export async function GET(_request: Request, context: RouteContext) {
  const { meetingId } = await context.params;
  if (!UUID_REGEX.test(meetingId)) {
    return NextResponse.json({ error: "Invalid meeting id." }, { status: 400 });
  }

  const queueReady = await ensureProcessingQueueTable();
  if (!queueReady) {
    return NextResponse.json(
      { error: "Database is not configured. Set DATABASE_URL." },
      { status: 500 },
    );
  }

  const jobResult = await getProcessingJobForMeeting(meetingId);
  if (jobResult.skipped) {
    return NextResponse.json(
      { error: "Database is not configured. Set DATABASE_URL." },
      { status: 500 },
    );
  }

  const meetingResult = await runQuery<MeetingStatusRow>(
    `
      select
        processing_status,
        error_message
      from meetings
      where meeting_id = $1
      limit 1
    `,
    [meetingId],
  );

  const meeting = meetingResult.rows[0] ?? null;

  return NextResponse.json({
    status: jobResult.job?.status ?? "not_queued",
    meeting_id: meetingId,
    model: jobResult.job?.model ?? null,
    attempts: jobResult.job?.attempts ?? 0,
    last_error: jobResult.job?.last_error ?? meeting?.error_message ?? null,
    meeting_status: meeting?.processing_status ?? null,
  });
}

