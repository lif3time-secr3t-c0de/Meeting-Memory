import { runQuery } from "@/lib/server/db";

type UploadRowInput = {
  meetingId: string;
  audioFile: string;
  userEmail: string;
  meetingDate?: Date;
};

type TranscriptRowInput = {
  meetingId: string;
  transcriptText: string;
  audioFile: string;
  promisesList: unknown[];
  fallbackUserEmail?: string;
  meetingDate?: Date;
};

export type MeetingListRow = {
  meeting_id: string;
  date: Date | string;
  processing_status: string;
  error_message: string | null;
  promise_count: number;
  done_count: number;
};

export async function upsertMeetingUpload(input: UploadRowInput): Promise<boolean> {
  const result = await runQuery(
    `
      insert into meetings (
        meeting_id,
        audio_file,
        user_email,
        date,
        processing_status,
        error_message
      )
      values ($1, $2, $3, $4, 'uploaded', null)
      on conflict (meeting_id) do update
      set
        audio_file = excluded.audio_file,
        user_email = excluded.user_email,
        date = excluded.date,
        processing_status = 'uploaded',
        error_message = null
    `,
    [input.meetingId, input.audioFile, input.userEmail, input.meetingDate ?? new Date()],
  );
  return !result.skipped;
}

export async function setMeetingStatus(
  meetingId: string,
  status: "transcribing" | "done" | "failed",
  errorMessage?: string | null,
): Promise<boolean> {
  const result = await runQuery(
    `
      update meetings
      set
        processing_status = $2,
        error_message = $3
      where meeting_id = $1
    `,
    [meetingId, status, errorMessage ?? null],
  );
  return !result.skipped;
}

export async function upsertMeetingTranscript(input: TranscriptRowInput): Promise<boolean> {
  const result = await runQuery(
    `
      insert into meetings (
        meeting_id,
        audio_file,
        text,
        user_email,
        date,
        promises_list,
        processing_status,
        error_message
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, 'done', null)
      on conflict (meeting_id) do update
      set
        audio_file = excluded.audio_file,
        text = excluded.text,
        promises_list = excluded.promises_list,
        date = coalesce(meetings.date, excluded.date),
        processing_status = 'done',
        error_message = null
    `,
    [
      input.meetingId,
      input.audioFile,
      input.transcriptText,
      input.fallbackUserEmail ?? "unknown@example.com",
      input.meetingDate ?? new Date(),
      JSON.stringify(input.promisesList ?? []),
    ],
  );
  return !result.skipped;
}

export async function listMeetingsForEmail(
  email: string,
  limit = 50,
): Promise<{ skipped: boolean; rows: MeetingListRow[] }> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    return { skipped: false, rows: [] };
  }

  const boundedLimit = Math.max(1, Math.min(limit, 200));
  const result = await runQuery<MeetingListRow>(
    `
      select
        m.meeting_id::text,
        m.date,
        m.processing_status,
        m.error_message,
        coalesce(jsonb_array_length(m.promises_list), 0)::integer as promise_count,
        coalesce(done_stats.done_count, 0)::integer as done_count
      from meetings m
      left join (
        select
          meeting_id,
          count(*)::integer as done_count
        from meeting_promise_states
        where done = true
        group by meeting_id
      ) done_stats
        on done_stats.meeting_id = m.meeting_id
      where lower(m.user_email) = lower($1)
      order by m.date desc
      limit $2
    `,
    [normalizedEmail, boundedLimit],
  );

  return {
    skipped: result.skipped,
    rows: result.rows,
  };
}
