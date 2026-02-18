# Meeting Memory - V1 Product Definition (Phase 1, Step 1)

## 1) Purpose
Meeting Memory turns spoken meeting commitments into a simple, trackable promise list with next-day reminders.

## 2) V1 Scope (What the app does)
1. User records one meeting (up to 60 minutes).
2. App converts speech to text transcript.
3. App extracts action items in this format:
   - `owner` (who)
   - `task` (what)
   - `due_date` (by when, if present)
4. App shows a clean list of promises/action items.
5. App sends reminders the next day for extracted action items.

## 3) V1 Non-Goals (What it does not do yet)
- Multi-language transcription.
- Multi-meeting calendar integration.
- Advanced project management features (status workflows, teams, comments).
- Real-time live captions during recording.
- Smart recurrence/reminder logic beyond next-day reminders.

## 4) Primary User Flow
1. User taps `Start Recording`.
2. User records meeting audio (max 60 min), then taps `Stop`.
3. App uploads/processes audio and shows `Transcribing...`.
4. App displays transcript and extracted action items.
5. User can quickly edit an action item (owner/task/date) before saving.
6. App stores final promises and schedules next-day reminders.

## 5) Functional Requirements
### Recording
- Must support start/stop recording.
- Must enforce a hard 60-minute recording limit.
- Must show recording timer and clear stop state.

### Transcription
- Must generate transcript after recording ends.
- Must return transcript text or a clear failure message with retry.

### Action Item Extraction
- Must parse transcript into structured action items.
- Each item must include:
  - owner (string; may be `Unknown` if missing)
  - task (required)
  - due_date (optional, ISO date if resolved)
  - source_quote (short supporting snippet)
- If no action items are detected, show "No commitments found."

### Promise List UI
- Must list extracted action items in simple cards/rows.
- Must allow user edits before final save.
- Must persist saved items.

### Reminder
- Must schedule one reminder for next day after meeting save.
- Reminder body should include owner + task (+ due date if present).
- If notifications are denied, app should show an in-app warning.

## 6) Data Model (V1)
### Meeting
- `id` (uuid)
- `created_at` (timestamp)
- `duration_seconds` (int, <= 3600)
- `audio_path` (string)
- `transcript_text` (text)

### ActionItem
- `id` (uuid)
- `meeting_id` (uuid, FK)
- `owner` (string)
- `task` (text)
- `due_date` (date, nullable)
- `source_quote` (text, nullable)
- `reminder_at` (timestamp)
- `status` (enum: `open`, `done`; default `open`)

## 7) Edge Cases
- Meeting exceeds 60 minutes: auto-stop and show message.
- Poor audio quality: transcription may be partial; allow retry.
- No clear owner/date in transcript: save with `Unknown` owner or blank due date.
- User leaves before processing completes: processing should resume on reopen.

## 8) Definition of Done for Step 1
- Scope is fixed and documented (this file).
- Inputs/outputs are explicit for each core feature.
- Success criteria are testable.

## 9) Acceptance Criteria (V1)
1. User can record audio and cannot exceed 60 minutes.
2. After recording, transcript appears (or explicit error state).
3. At least one transcript with commitments yields structured action items.
4. User sees and can edit promise list before saving.
5. Next-day reminder is scheduled for each saved action item.

## 10) Open Decisions for Step 2 (Planning Setup)
1. Platform target first: Web app, mobile app, or both.
2. Tech stack: frontend, backend, DB, transcription provider, LLM provider.
3. Auth: anonymous local-only or signed-in users.
4. Reminder channel: push notification, email, or both.

## 11) Step 2 Decisions (Resolved)
- Platform: Web-first responsive app (mobile + desktop browsers).
- Frontend: Next.js + TypeScript + Tailwind + MediaRecorder API.
- Backend: Next.js Route Handlers + OpenAI transcription/extraction.
- Storage: Supabase (PostgreSQL + Storage bucket).
- Reminder channel: Email reminders using Resend, scheduled with QStash.
