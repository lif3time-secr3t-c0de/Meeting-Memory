# Meeting Memory - Phase 5 Step 9 (Simple Dashboard)

## Dashboard behavior
When user returns, app loads last meeting summary from local storage + API:
- `meeting_memory_last_meeting_id`
- Fetches `GET /api/meetings/{meetingId}/summary`

## What user sees
- Header: `Your Meeting Summary - <date>`
- Promises list with checkboxes:
  - `Person: task by deadline (actual date)`
- `Full Transcript (click to expand)` section
- `Download Audio` button
- `New Meeting` button

## Mobile-first design details
- One compact screen (`max-w-4xl`)
- Large touch targets (`h-12` buttons)
- Minimal clutter and no secondary panels
- Transcript collapsed by default (`<details>`)

## Persistence
- Completed checkboxes are saved per meeting in local storage:
  - `meeting_memory_done_{meetingId}`

## New API routes
- `GET /api/meetings/{meetingId}/summary`
- `GET /api/meetings/{meetingId}/audio`

## Files changed
- `web/app/page.tsx`
- `web/app/api/meetings/[meetingId]/summary/route.ts`
- `web/app/api/meetings/[meetingId]/audio/route.ts`
- `web/app/api/meetings/[meetingId]/process/route.ts`
- `docs/v1-step9-simple-dashboard.md`
