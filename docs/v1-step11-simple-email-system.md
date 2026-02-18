# Step 11: Simple Email System

## Goal

Keep reminder emails simple:

1. Plain-text messages only
2. One clear message per email
3. Two primary action links ("buttons" in text form)
4. Unsubscribe link in every reminder

## Implemented Providers

Provider is selected by `EMAIL_PROVIDER`:

- `gmail_smtp`
- `sendgrid_smtp`
- `ses_smtp`
- `smtp` (generic)
- `log` (local debug mode)

`gmail_smtp`, `sendgrid_smtp`, and `ses_smtp` all use SMTP transport with provider defaults.

## Environment Variables

Required for real email sending:

- `EMAIL_PROVIDER` (`gmail_smtp`, `sendgrid_smtp`, `ses_smtp`, or `smtp`)
- `REMINDER_FROM_EMAIL` (or `SMTP_FROM_EMAIL`)
- `SMTP_USER`
- `SMTP_PASS`

Optional:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE` (`true`/`false`)
- `AWS_REGION` (used for default SES SMTP host)
- `APP_BASE_URL` (recommended for unsubscribe links)

If required config is missing, sender falls back to log mode.

## Reminder Content Style

Reminder emails now send text-only bodies:

- Next-day summary:
  - clear task list
  - `YES, DONE` and `NOT YET` links
- Due tomorrow:
  - `YES, DONE` and `NOT YET` links
- Overdue:
  - `YES, DONE` and `RESCHEDULE` links
- Every email includes:
  - `Unsubscribe: <link>`

## Unsubscribe Flow

- New endpoint: `GET /api/reminders/unsubscribe?token=...`
- Token is signed and expires (same signing secret as reminder tokens)
- Unsubscribed emails are stored in `email_unsubscribes`
- Reminder runs exclude unsubscribed emails

## Database Additions

- `email_unsubscribes`
  - `email` (PK)
  - `reason`
  - `unsubscribed_at`
