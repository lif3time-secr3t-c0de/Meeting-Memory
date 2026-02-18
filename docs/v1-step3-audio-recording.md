# Meeting Memory - Phase 2 Step 3 (Audio Recording)

## What was built
- Browser mic permission request on record click.
- Audio capture in 1-second chunks using `MediaRecorder`.
- Live timer with hard 60-minute auto-stop.
- Live waveform visualization during recording.
- Hard 50MB limit with automatic stop.
- Chunks kept in browser memory until upload completes.
- Upload panel with `Processing...` state + upload percentage.
- Backend upload endpoint validates file size/type and stores file.

## Files changed
- `web/app/page.tsx`
- `web/app/api/meetings/route.ts`
- `web/app/layout.tsx`
- `web/app/globals.css`
- `web/next.config.ts`
- `web/.gitignore`

## Current format behavior
- Preferred recording format: `WebM` (`audio/webm;codecs=opus` fallback chain).
- `MP3` accepted by backend upload endpoint.
- Max upload size: `50MB`.

## Run locally
1. `cd web`
2. `npm install` (already done once in this workspace)
3. `npm run dev`
4. Open `http://localhost:3000`
