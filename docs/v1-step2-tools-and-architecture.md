# Meeting Memory - V1 Tools and Architecture (Phase 1, Step 2)

## 1) Final Tool Choices
### Frontend (user-facing)
- Framework: `Next.js` + `TypeScript`
- UI: `Tailwind CSS` (responsive layout for phone + desktop)
- Audio capture: Browser `MediaRecorder` API
- Progress UI: poll meeting status (`uploading -> transcribing -> extracting -> done/failed`) every 2-3 seconds

Why this choice:
- One codebase works on mobile browsers and desktop browsers.
- MediaRecorder is native in modern browsers and easy to ship quickly.
- Next.js keeps frontend + backend in one project for faster delivery.

### Backend (server-side)
- API server: `Next.js Route Handlers` (Node runtime)
- Transcription: `OpenAI` speech-to-text model
- Action-item extraction: `OpenAI` LLM with strict JSON output
- Audio storage: `Supabase Storage` bucket
- Reminder scheduling: `Upstash QStash` delayed job (next day)
- Reminder sending: `Resend` email API

Why this choice:
- Fast implementation with minimal ops.
- Reliable delayed reminders without running your own cron server.
- Clean separation: upload, process, save, remind.

### Database (storage)
- DB engine: `PostgreSQL` (via Supabase)
- Single table for V1: `meetings`
- `promises_list` stored as `JSONB` array of action items

## 2) V1 Database Shape
This matches your required columns:
- `meeting_id`
- `audio_file`
- `text`
- `promises_list`
- `user_email`
- `date`

Operational columns for backend progress/retries:
- `processing_status`
- `error_message`

See SQL in `db/schema.sql`.

## 3) API Endpoints (V1)
1. `POST /api/meetings`
   - Input: audio blob + user email
   - Output: `meeting_id`
   - Action: upload audio, create row, set status `uploading`

2. `POST /api/meetings/{meeting_id}/process`
   - Input: `meeting_id`
   - Action: transcribe + extract promises + save to DB
   - Status transitions: `transcribing -> extracting -> done/failed`

3. `GET /api/meetings/{meeting_id}`
   - Output: current processing status + transcript + promises list
   - Used by frontend polling for progress display

4. `POST /api/reminders/schedule`
   - Input: `meeting_id`
   - Action: queue next-day reminder job

5. `POST /api/reminders/send` (internal job endpoint)
   - Input: queued payload with `meeting_id`
   - Action: email user with extracted promises

## 4) Promise JSON Format (inside `promises_list`)
```json
[
  {
    "owner": "Ali",
    "task": "Send revised budget draft",
    "due_date": "2026-02-20"
  }
]
```

## 5) Progress States for Frontend
- `idle`
- `uploading`
- `transcribing`
- `extracting`
- `done`
- `failed`

This supports your "shows progress while processing" requirement.

## 6) Environment Variables (planned)
- `OPENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET`
- `QSTASH_TOKEN`
- `RESEND_API_KEY`
- `REMINDER_FROM_EMAIL`

## 7) Phase 1 Step 2 Exit Criteria
1. Tool stack chosen and frozen for V1.
2. API/data flow clear enough to start coding.
3. DB schema drafted and ready for migration.
