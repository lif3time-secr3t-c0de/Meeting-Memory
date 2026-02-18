# Meeting Memory - Phase 2 Step 4 (Upload to Server)

## Flow implemented
1. Recording stops.
2. App asks for reminder email.
3. User enters email.
4. App uploads `audio + email` to server.
5. Server confirms: `"Got it, processing now."`

## Reliability for slow internet
- Upload now uses chunked transfer (2MB chunks).
- If upload fails, app shows `Retry Upload`.
- Retry resumes from the last successful chunk (does not restart from zero).

## Files changed
- `web/app/page.tsx`
- `web/app/api/meetings/chunk/route.ts`
- `web/app/api/meetings/route.ts`

## Server response on complete upload
```json
{
  "status": "complete",
  "meeting_id": "uuid",
  "message": "Got it, processing now."
}
```
