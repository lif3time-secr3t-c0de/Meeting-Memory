# Step 10: Email Reminders

## Goal

Send reminder emails for extracted meeting promises:

1. Next day after meeting: summary of open promises.
2. Day before due date: reminder task is due tomorrow.
3. Day after due date: overdue reminder.

Each email includes action links so the user can mark a task `done`, `not yet`, or `reschedule`.

## Implemented Endpoints

- `GET/POST /api/reminders/run`
  - Runs reminder logic for a target date.
  - Optional query/body fields:
    - `date` (`YYYY-MM-DD`) defaults to today.
    - `dry_run` (`true|false|1|0|yes|no`) defaults to `false`.
  - Optional auth:
    - If `REMINDERS_CRON_SECRET` is set, request must include:
      - `x-reminders-secret: <secret>` or
      - `Authorization: Bearer <secret>`

- `GET/POST /api/reminders/action`
  - Handles reminder email action links.
  - Signed token verifies `meetingId`, `promiseIndex`, `action`, expiry.
  - Actions:
    - `done`: marks promise as complete.
    - `not_yet`: keeps open and increments not-yet count.
    - `reschedule`: shows a date form, then stores new due date.

## Data Model

Added reminder tables:

- `meeting_promise_states`
  - per-promise state (`done`, `done_at`, `rescheduled_to`, `not_yet_count`)

- `reminder_events`
  - dedupe log so the same reminder type is not sent twice for the same date

Both tables are in `db/schema.sql` and also auto-created at runtime by `ensureReminderTables()`.

## Email Provider

`sendReminderEmail()` supports:

- Resend (production):
  - requires `RESEND_API_KEY` and `REMINDER_FROM_EMAIL`
- Log mode (local fallback):
  - if env vars are missing, email payload is logged and treated as sent

## Required/Optional Environment Variables

- `DATABASE_URL` (required for reminders)
- `DATABASE_SSL` (optional, set `true` if needed by DB provider)
- `APP_BASE_URL` (recommended so email action links are correct)
- `REMINDERS_CRON_SECRET` (optional but recommended for cron endpoint protection)
- `REMINDER_SIGNING_SECRET` (recommended for signed action tokens)
- `RESEND_API_KEY` and `REMINDER_FROM_EMAIL` (required for real email sending)

## Example Runs

Dry run for today:

```bash
curl "http://localhost:3000/api/reminders/run?dry_run=true"
```

Dry run for specific date:

```bash
curl "http://localhost:3000/api/reminders/run?date=2026-02-17&dry_run=true"
```

Protected run:

```bash
curl -H "x-reminders-secret: YOUR_SECRET" "http://localhost:3000/api/reminders/run"
```
