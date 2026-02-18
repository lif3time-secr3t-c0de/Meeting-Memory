import { runQuery } from "@/lib/server/db";

export type ProcessingJobStatus = "queued" | "processing" | "done" | "failed";

export type ProcessingJobRow = {
  job_id: string;
  meeting_id: string;
  model: string;
  status: ProcessingJobStatus;
  attempts: number;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export async function ensureProcessingQueueTable(): Promise<boolean> {
  const result = await runQuery(`
    create table if not exists meeting_processing_jobs (
      job_id uuid primary key default gen_random_uuid(),
      meeting_id uuid not null unique references meetings(meeting_id) on delete cascade,
      model text not null default 'base',
      status text not null default 'queued',
      attempts integer not null default 0,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  if (result.skipped) return false;

  await runQuery(`
    create index if not exists idx_meeting_processing_jobs_status_created
      on meeting_processing_jobs (status, created_at asc)
  `);

  return true;
}

export async function enqueueProcessingJob(
  meetingId: string,
  model: "tiny" | "base",
): Promise<{ skipped: boolean; enqueued: boolean }> {
  const result = await runQuery(
    `
      insert into meeting_processing_jobs (
        meeting_id,
        model,
        status,
        attempts,
        last_error,
        created_at,
        updated_at
      )
      values ($1, $2, 'queued', 0, null, now(), now())
      on conflict (meeting_id) do update
      set
        model = excluded.model,
        status = case
          when meeting_processing_jobs.status = 'processing' then meeting_processing_jobs.status
          else 'queued'
        end,
        last_error = case
          when meeting_processing_jobs.status = 'processing' then meeting_processing_jobs.last_error
          else null
        end,
        updated_at = now()
    `,
    [meetingId, model],
  );

  return {
    skipped: result.skipped,
    enqueued: !result.skipped,
  };
}

export async function claimNextProcessingJob(): Promise<{
  skipped: boolean;
  job: ProcessingJobRow | null;
}> {
  const result = await runQuery<ProcessingJobRow>(
    `
      with next_job as (
        select job_id
        from meeting_processing_jobs
        where status = 'queued'
        order by created_at asc
        limit 1
        for update skip locked
      )
      update meeting_processing_jobs as jobs
      set
        status = 'processing',
        attempts = jobs.attempts + 1,
        updated_at = now(),
        last_error = null
      from next_job
      where jobs.job_id = next_job.job_id
      returning
        jobs.job_id::text,
        jobs.meeting_id::text,
        jobs.model,
        jobs.status,
        jobs.attempts,
        jobs.last_error,
        jobs.created_at,
        jobs.updated_at
    `,
  );

  return {
    skipped: result.skipped,
    job: result.rows[0] ?? null,
  };
}

export async function markProcessingJobStatus(
  meetingId: string,
  status: ProcessingJobStatus,
  lastError: string | null = null,
): Promise<boolean> {
  const result = await runQuery(
    `
      update meeting_processing_jobs
      set
        status = $2,
        last_error = $3,
        updated_at = now()
      where meeting_id = $1
    `,
    [meetingId, status, lastError],
  );
  return !result.skipped;
}

export async function getProcessingJobForMeeting(meetingId: string): Promise<{
  skipped: boolean;
  job: ProcessingJobRow | null;
}> {
  const result = await runQuery<ProcessingJobRow>(
    `
      select
        job_id::text,
        meeting_id::text,
        model,
        status,
        attempts,
        last_error,
        created_at,
        updated_at
      from meeting_processing_jobs
      where meeting_id = $1
      limit 1
    `,
    [meetingId],
  );

  return {
    skipped: result.skipped,
    job: result.rows[0] ?? null,
  };
}

