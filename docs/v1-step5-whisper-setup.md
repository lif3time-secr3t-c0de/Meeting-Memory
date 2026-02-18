# Meeting Memory - Phase 3 Step 5 (Whisper AI)

## What was implemented
- Python Whisper runner script: `web/python/transcribe_with_whisper.py`
- Whisper dependencies file: `web/python/requirements.txt`
- Processing API route: `web/app/api/meetings/[meetingId]/process/route.ts`
- Frontend control to run Whisper (`tiny` or `base`) after upload
- Transcript saved to `web/tmp/transcripts/{meetingId}.json`

## Whisper flow
1. API receives `meetingId` + model choice (`tiny`/`base`).
2. Server finds uploaded audio in `web/tmp/recordings`.
3. Python script loads Whisper model (download happens first run only).
4. Whisper transcribes and stitches text output.
5. API returns transcript and timing metadata.

## Friendly error mapping
- Bad audio -> `Couldn't hear clearly`
- Too long (>1 hour) -> `Please split into 1 hour parts`
- Background noise -> `Try quieter place`

## Server setup (Windows PowerShell)
1. `cd web`
2. `python -m venv .venv`
3. `.\\.venv\\Scripts\\Activate.ps1`
4. `python -m pip install --upgrade pip`
5. `python -m pip install -r python/requirements.txt`
6. Install `ffmpeg` and ensure `ffmpeg` is in PATH
7. Optional pre-download model:
   - `python -c "import whisper; whisper.load_model('base')"`

## Choose model
- `tiny`: fastest, lower accuracy
- `base`: slower, better balance (recommended for V1)

## API usage
`POST /api/meetings/{meetingId}/process`

Body:
```json
{
  "model": "base"
}
```
