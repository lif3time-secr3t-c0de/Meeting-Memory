# Step 12: Complete User Journey

## First-Time User Flow

1. User lands on `/` and sees a simple landing with:
   - `Start Meeting`
   - `Open My Meetings`
2. User clicks `Start Meeting`:
   - browser asks for microphone permission
   - recording UI opens
3. User records, stops, enters email, uploads audio.
4. UI confirms:
   - "Got it, processing now. We'll email you when your summary is ready."
5. After processing completes, app sends a summary-ready email with:
   - direct meeting link
   - meetings inbox link

## Returning User Flow

1. User opens email link:
   - `/?inbox=<signed_token>` opens meetings inbox list
   - `/?meeting_id=<id>` opens a specific meeting summary
2. User sees list of meetings and open/done task counts.
3. User opens a meeting and reviews promises.
4. User marks tasks done from checkboxes.
5. Task status is saved server-side and reminder logic skips done tasks.

## APIs Added For This Journey

- `GET /api/meetings/list`
  - supports `token` (signed inbox token) or `email`
  - returns meetings for that inbox

- `POST /api/meetings/[meetingId]/promises/[promiseIndex]/status`
  - body: `{ "done": true | false }`
  - persists completion state for reminders

## Email Updates

- Reminder emails now include:
  - action links
  - "View all meetings" inbox link
  - unsubscribe link

- Whisper completion now sends:
  - "Your meeting summary is ready" email
