# Meeting Memory - Phase 4 Step 8 (Structured Action Data)

## Output schema
Action items are now normalized to this JSON shape:

```json
[
  {
    "person": "Speaker",
    "task": "send report",
    "deadline": "tomorrow",
    "actual_date": "2026-02-18"
  }
]
```

## Implemented logic
- `person`: inferred from sentence owner (`I` -> `Speaker`, `We` -> `We`, `Alex` -> `Alex`)
- `task`: extracted from commitment phrase (`will`, `I'll`, `can you`, etc.)
- `deadline`: normalized phrase (`tomorrow`, `Monday`, `next week`, `3/20`)
- `actual_date`: ISO date resolved from `deadline` relative to meeting timestamp

## Where this is used
- API response from `POST /api/meetings/{meetingId}/process` in `promises_list`
- Stored in database `meetings.promises_list` (jsonb)
- Displayed in UI promises panel

## Files changed
- `web/lib/server/action-items.ts`
- `web/app/page.tsx`
- `docs/v1-step8-structured-action-data.md`
