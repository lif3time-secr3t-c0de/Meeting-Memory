-- Meeting Memory V1 schema
-- PostgreSQL (Supabase-compatible)

create extension if not exists "pgcrypto";

create table if not exists meetings (
  meeting_id uuid primary key default gen_random_uuid(),
  audio_file text not null,
  text text,
  promises_list jsonb not null default '[]'::jsonb,
  user_email text not null,
  date timestamptz not null default now(),
  processing_status text not null default 'idle',
  error_message text
);

create index if not exists idx_meetings_user_email_date
  on meetings (user_email, date desc);

create table if not exists meeting_promise_states (
  meeting_id uuid not null references meetings(meeting_id) on delete cascade,
  promise_index integer not null check (promise_index >= 0),
  done boolean not null default false,
  done_at timestamptz,
  rescheduled_to date,
  not_yet_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (meeting_id, promise_index)
);

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
);

create index if not exists idx_reminder_events_date_type
  on reminder_events (scheduled_for, reminder_type);

create index if not exists idx_promise_states_done
  on meeting_promise_states (done, updated_at desc);

create table if not exists email_unsubscribes (
  email text primary key,
  reason text,
  unsubscribed_at timestamptz not null default now()
);

create index if not exists idx_email_unsubscribes_at
  on email_unsubscribes (unsubscribed_at desc);

create table if not exists meeting_processing_jobs (
  job_id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null unique references meetings(meeting_id) on delete cascade,
  model text not null default 'base',
  status text not null default 'queued',
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_meeting_processing_jobs_status_created
  on meeting_processing_jobs (status, created_at asc);
