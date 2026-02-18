# Meeting Memory - Phase 4 Step 7 (Extract Action Items)

## Implemented method
Pattern matching (`pattern_match_v1`) on transcript sentences using:
- Future words: `will`, `I'll`, `going to`, `tomorrow`, `next week`, `by ...`
- Action verbs: `send`, `do`, `make`, `update`, `check`, `create` (plus similar)
- Person detection:
  - `I will` -> `Speaker`
  - `We will` -> `We`
  - `Alex will` or `Alex, can you ...` -> `Alex`

## Extraction output
Each action item includes:
- `owner`
- `task`
- `due_phrase`
- `due_date` (ISO date when resolvable)
- `source_sentence`
- `method = pattern_match_v1`

## Deadline conversion
Converted to actual date relative to meeting time for:
- `tomorrow`
- `next week`
- `next month`
- weekdays (`Friday`, `Monday`, `next Friday`)
- numeric dates (`3/12`, `3/12/2026`)

## Storage
On successful transcription, API now saves:
- full transcript to `meetings.text`
- extracted action items to `meetings.promises_list` (`jsonb`)
- status to `processing_status = done`

## Files changed
- `web/lib/server/action-items.ts`
- `web/app/api/meetings/[meetingId]/process/route.ts`
- `web/lib/server/meetings-repo.ts`
- `web/app/page.tsx`
- `docs/v1-step7-action-item-extraction.md`
