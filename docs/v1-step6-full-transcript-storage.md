# Meeting Memory - Phase 3 Step 6 (Full Transcript Storage)

## What is now saved
After Whisper transcription completes, the app saves to database:
- Full transcript text (`text`)
- Link/path to original audio (`audio_file`)
- Meeting timestamp (`date`)

## Database behavior
- Upload endpoints now upsert a `meetings` row with:
  - `meeting_id`
  - `audio_file`
  - `user_email`
  - `date`
  - `processing_status = uploaded`
- Whisper process endpoint updates same meeting row with:
  - `text` (full transcript)
  - `processing_status = done`
  - `error_message = null`

If transcription fails, status is saved as:
- `processing_status = failed`
- `error_message = <friendly error>`

## Files added
- `web/lib/server/db.ts`
- `web/lib/server/meetings-repo.ts`
- `docs/v1-step6-full-transcript-storage.md`

## Files updated
- `web/app/api/meetings/route.ts`
- `web/app/api/meetings/chunk/route.ts`
- `web/app/api/meetings/[meetingId]/process/route.ts`
- `web/package.json`
- `web/package-lock.json`

## Environment required
Set `DATABASE_URL` in `web/.env.local` for database writes.

Without `DATABASE_URL`, transcription still runs and returns transcript, but API will indicate:
- `"database_saved": false`
