# Step 13: Real Meeting Tests And Launch

## Test Matrix

Run these manual tests with real recordings:

1. 5-minute quick meeting
   - Expect upload + auto-processing to finish quickly.
   - Expect at least one extracted action item when commitments are spoken clearly.

2. 1-hour long meeting
   - Expect recording limit handling and successful chunk upload.
   - Expect Whisper processing time in the 5-10 minute range.

3. Noisy coffee shop recording
   - Expect pre-processing warning before Whisper starts.
   - Expect possible quality warnings after transcription.

4. Multiple people talking
   - Expect transcript to remain coherent.
   - Expect action extraction still finds person/task/deadline patterns.

5. Heavy accents
   - If transcription fails with `unclear_audio`, expect guidance to speak slower/clearer.

6. Non-English words mixed in
   - Expect transcript to keep non-English words when audible.
   - Verify action items are still extracted when commitment patterns are clear.

## Product Behaviors Added

- Accent-failure guidance:
  - server now returns clearer hint for `unclear_audio` failures.

- Noise warning before processing:
  - client computes waveform risk during recording.
  - if noisy, auto-processing pauses and user sees warning + `Process Anyway`.

- No-action-items message:
  - standardized message:
    - `We couldn't find clear action items`

## Launch Checklist

1. Set required env vars:
   - `DATABASE_URL`
   - `APP_BASE_URL`
   - `REMINDER_SIGNING_SECRET`
   - Email provider vars (`EMAIL_PROVIDER`, `SMTP_*`, `REMINDER_FROM_EMAIL`)

2. Run reminder scheduler daily:
   - call `/api/reminders/run` with `REMINDERS_CRON_SECRET`

3. Verify production email links:
   - meeting link (`/?meeting_id=...`)
   - inbox link (`/?inbox=...`)
   - unsubscribe link

4. Run all six test scenarios before public launch.
