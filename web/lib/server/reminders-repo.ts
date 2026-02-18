import { runQuery } from "@/lib/server/db";

export type ReminderType =
  | "summary_ready"
  | "next_day_summary"
  | "due_tomorrow"
  | "overdue";

export type MeetingReminderRow = {
  meeting_id: string;
  user_email: string;
  date: Date | string;
  promises_list: unknown;
};

export type PromiseStateRow = {
  meeting_id: string;
  promise_index: number;
  done: boolean;
  done_at: Date | string | null;
  rescheduled_to: Date | string | null;
  not_yet_count: number;
  updated_at: Date | string;
};

export async function ensureReminderTables(): Promise<boolean> {
  const first = await runQuery(`
    create table if not exists meeting_promise_states (
      meeting_id uuid not null references meetings(meeting_id) on delete cascade,
      promise_index integer not null check (promise_index >= 0),
      done boolean not null default false,
      done_at timestamptz,
      rescheduled_to date,
      not_yet_count integer not null default 0,
      updated_at timestamptz not null default now(),
      primary key (meeting_id, promise_index)
    )
  `);
  if (first.skipped) return false;

  await runQuery(`
    create table if not exists reminder_events (
      id uuid primary key default gen_random_uuid(),
      meeting_id uuid not null references meetings(meeting_id) on delete cascade,
      promise_index integer not null default -1,
      reminder_type text not null,
      scheduled_for date not null,
      email text not null,
      subject text not null,
      sent_at timestamptz not null default now(),
      meta jsonb not null default '{}'::jsonb,
      unique (meeting_id, promise_index, reminder_type, scheduled_for)
    )
  `);

  await runQuery(`
    create index if not exists idx_reminder_events_date_type
      on reminder_events (scheduled_for, reminder_type)
  `);

  await runQuery(`
    create index if not exists idx_promise_states_done
      on meeting_promise_states (done, updated_at desc)
  `);

  await runQuery(`
    create table if not exists email_unsubscribes (
      email text primary key,
      reason text,
      unsubscribed_at timestamptz not null default now()
    )
  `);

  await runQuery(`
    create index if not exists idx_email_unsubscribes_at
      on email_unsubscribes (unsubscribed_at desc)
  `);

  return true;
}

export async function getMeetingsForReminders(): Promise<{
  skipped: boolean;
  rows: MeetingReminderRow[];
}> {
  const result = await runQuery<MeetingReminderRow>(
    `
      select
        meeting_id::text,
        user_email,
        date,
        promises_list
      from meetings
      left join email_unsubscribes u
        on lower(u.email) = lower(meetings.user_email)
      where processing_status = 'done'
        and user_email is not null
        and user_email <> ''
        and u.email is null
        and jsonb_typeof(promises_list) = 'array'
        and jsonb_array_length(promises_list) > 0
      order by date desc
      limit 1000
    `,
  );
  return {
    skipped: result.skipped,
    rows: result.rows,
  };
}

export async function getPromiseStateMap(meetingId: string): Promise<{
  skipped: boolean;
  map: Map<number, PromiseStateRow>;
}> {
  const result = await runQuery<PromiseStateRow>(
    `
      select
        meeting_id::text,
        promise_index,
        done,
        done_at,
        rescheduled_to,
        not_yet_count,
        updated_at
      from meeting_promise_states
      where meeting_id = $1
    `,
    [meetingId],
  );

  const map = new Map<number, PromiseStateRow>();
  for (const row of result.rows) {
    map.set(row.promise_index, row);
  }

  return {
    skipped: result.skipped,
    map,
  };
}

export async function markPromiseDone(
  meetingId: string,
  promiseIndex: number,
  done: boolean,
): Promise<boolean> {
  const result = await runQuery(
    `
      insert into meeting_promise_states (
        meeting_id,
        promise_index,
        done,
        done_at,
        rescheduled_to,
        updated_at
      )
      values ($1, $2, $3, case when $3 then now() else null end, null, now())
      on conflict (meeting_id, promise_index) do update
      set
        done = excluded.done,
        done_at = excluded.done_at,
        updated_at = now()
    `,
    [meetingId, promiseIndex, done],
  );
  return !result.skipped;
}

export async function markPromiseNotYet(
  meetingId: string,
  promiseIndex: number,
): Promise<boolean> {
  const result = await runQuery(
    `
      insert into meeting_promise_states (
        meeting_id,
        promise_index,
        done,
        done_at,
        not_yet_count,
        updated_at
      )
      values ($1, $2, false, null, 1, now())
      on conflict (meeting_id, promise_index) do update
      set
        done = false,
        done_at = null,
        not_yet_count = meeting_promise_states.not_yet_count + 1,
        updated_at = now()
    `,
    [meetingId, promiseIndex],
  );
  return !result.skipped;
}

export async function reschedulePromise(
  meetingId: string,
  promiseIndex: number,
  rescheduledTo: string,
): Promise<boolean> {
  const result = await runQuery(
    `
      insert into meeting_promise_states (
        meeting_id,
        promise_index,
        done,
        done_at,
        rescheduled_to,
        updated_at
      )
      values ($1, $2, false, null, $3::date, now())
      on conflict (meeting_id, promise_index) do update
      set
        done = false,
        done_at = null,
        rescheduled_to = excluded.rescheduled_to,
        updated_at = now()
    `,
    [meetingId, promiseIndex, rescheduledTo],
  );
  return !result.skipped;
}

export async function hasReminderEvent(
  meetingId: string,
  promiseIndex: number,
  reminderType: ReminderType,
  scheduledFor: string,
): Promise<boolean> {
  const result = await runQuery<{ exists: boolean }>(
    `
      select exists(
        select 1
        from reminder_events
        where meeting_id = $1
          and promise_index = $2
          and reminder_type = $3
          and scheduled_for = $4::date
      ) as exists
    `,
    [meetingId, promiseIndex, reminderType, scheduledFor],
  );
  if (result.skipped) return false;
  return Boolean(result.rows[0]?.exists);
}

export async function recordReminderEvent(input: {
  meetingId: string;
  promiseIndex: number;
  reminderType: ReminderType;
  scheduledFor: string;
  email: string;
  subject: string;
  meta?: Record<string, unknown>;
}): Promise<boolean> {
  const result = await runQuery(
    `
      insert into reminder_events (
        meeting_id,
        promise_index,
        reminder_type,
        scheduled_for,
        email,
        subject,
        meta
      )
      values ($1, $2, $3, $4::date, $5, $6, $7::jsonb)
      on conflict (meeting_id, promise_index, reminder_type, scheduled_for)
      do nothing
    `,
    [
      input.meetingId,
      input.promiseIndex,
      input.reminderType,
      input.scheduledFor,
      input.email,
      input.subject,
      JSON.stringify(input.meta ?? {}),
    ],
  );
  return !result.skipped && result.rowCount > 0;
}

export async function resetReminderTrackingForMeeting(meetingId: string): Promise<boolean> {
  const first = await runQuery(
    `
      delete from meeting_promise_states
      where meeting_id = $1
    `,
    [meetingId],
  );
  if (first.skipped) return false;

  await runQuery(
    `
      delete from reminder_events
      where meeting_id = $1
    `,
    [meetingId],
  );
  return true;
}

export async function unsubscribeReminderEmail(
  email: string,
  reason: string | null = null,
): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;

  const result = await runQuery(
    `
      insert into email_unsubscribes (
        email,
        reason,
        unsubscribed_at
      )
      values ($1, $2, now())
      on conflict (email) do update
      set
        reason = excluded.reason,
        unsubscribed_at = now()
    `,
    [normalized, reason],
  );

  return !result.skipped;
}

export async function isReminderEmailUnsubscribed(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;

  const result = await runQuery<{ exists: boolean }>(
    `
      select exists(
        select 1
        from email_unsubscribes
        where lower(email) = lower($1)
      ) as exists
    `,
    [normalized],
  );

  if (result.skipped) return false;
  return Boolean(result.rows[0]?.exists);
}
