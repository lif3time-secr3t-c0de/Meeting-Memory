# Biggest Challenges And Solutions

## 1) Long Processing Time

- Solution implemented:
  - Transcription progress bar in UI while Whisper runs.
  - Summary-ready email once processing completes.
- Files:
  - `web/app/page.tsx`
  - `web/app/api/meetings/[meetingId]/process/route.ts`

## 2) Bad Audio Quality

- Solution implemented:
  - Clear guidance messages for unclear audio and background noise.
  - Pre-processing noise warning before Whisper starts.
  - Post-processing quality warnings from Whisper metrics.
- Files:
  - `web/app/page.tsx`
  - `web/app/api/meetings/[meetingId]/process/route.ts`

## 3) Missed Promises

- Solution implemented:
  - Manual promise add form on meeting summary page.
  - API endpoint to append manual tasks to `promises_list`.
- Files:
  - `web/app/page.tsx`
  - `web/app/api/meetings/[meetingId]/promises/manual/route.ts`

## 4) Privacy Concerns

- Solution implemented:
  - Audio deletion after processing (default enabled).
  - Download link is removed when audio is deleted.
- Env:
  - `DELETE_AUDIO_AFTER_PROCESSING=true` (default when unset)
- Files:
  - `web/app/api/meetings/[meetingId]/process/route.ts`
  - `web/app/api/meetings/[meetingId]/summary/route.ts`

## 5) Spam Emails

- Solution implemented:
  - One-click unsubscribe with signed token.
- Files:
  - `web/app/api/reminders/unsubscribe/route.ts`
  - `web/lib/server/reminder-token.ts`

## 6) Server Overload

- Solution implemented:
  - Database-backed processing queue endpoints.
  - Worker endpoint claims queued jobs and processes one or more jobs.
- Endpoints:
  - `POST /api/meetings/[meetingId]/queue` (enqueue)
  - `GET /api/meetings/[meetingId]/queue` (job status)
  - `POST /api/processing/worker` (run worker)
- Files:
  - `web/lib/server/processing-queue-repo.ts`
  - `web/app/api/meetings/[meetingId]/queue/route.ts`
  - `web/app/api/processing/worker/route.ts`
