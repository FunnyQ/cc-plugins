# Task 10: Add Data Health Diagnostics

## Context

Token Atlas is a local usage dashboard for Claude Code and Codex data. It lives at `token-atlas/skills/dashboard/`.

Key files:

- Data engine: `token-atlas/skills/dashboard/scripts/api.ts`
- Frontend app logic: `token-atlas/skills/dashboard/dashboard/dist/app.js`
- Markup: `token-atlas/skills/dashboard/dashboard/dist/index.html`
- Styles: `token-atlas/skills/dashboard/dashboard/dist/style.css`
- Product context: `token-atlas/skills/dashboard/PRODUCT.md`

Data sources currently include:

- `~/.claude/stats-cache.json`
- `~/.claude/history.jsonl`
- `~/.claude/sessions/`
- `~/.claude/projects/`
- `~/.codex/state_5.sqlite`
- `~/.codex/sessions/`
- `~/.config/cc-dashboard/pricing.json` for optional pricing override

Some missing sources are valid depending on whether Claude Code or Codex has been used. The dashboard should distinguish "not present" from "present but unreadable" where possible.

## Goal

Add a data health section that explains which local sources were read and whether any data is missing, stale, or degraded.

## Requirements

- Expose `dataHealth` metadata from `api.ts`.
- Show a compact diagnostics panel in the UI.
- Track at least:
  - source path
  - status: `ok`, `missing`, `unreadable`, or `empty`
  - last modified time if available
  - brief note
- Include counts where useful:
  - Claude project transcript files found
  - Codex session files found
  - Codex thread rows found
- Do not fail the whole dashboard because optional sources are missing.
- Keep the existing hard requirement for `stats-cache.json` unless intentionally changing startup behavior.

## Suggested API Shape

```json
{
  "dataHealth": {
    "sources": [
      {
        "name": "Claude stats cache",
        "path": "~/.claude/stats-cache.json",
        "status": "ok",
        "modifiedAt": "2026-05-17T00:00:00.000Z",
        "note": "required"
      }
    ],
    "counts": {
      "claudeTranscriptFiles": 0,
      "codexSessionFiles": 0,
      "codexThreadRows": 0
    }
  }
}
```

Exact shape may differ, but keep it stable and easy for the UI to render.

## Implementation Notes

- Add small filesystem helper functions in `api.ts`:
  - check existence
  - check readability
  - get mtime
  - count matching files
- Avoid expensive extra walks if the code already walks the same directories. Reuse counts from existing parsing where reasonable.
- Do not expose file contents.

## UX Notes

- Place diagnostics near footer or behind a compact expandable section.
- Use calm statuses. Missing Codex data is not necessarily an error.
- Make local trust visible through precise metadata, not privacy theater.

## Acceptance Criteria

- UI shows source statuses and counts.
- Missing optional sources render as non-fatal diagnostics.
- Unreadable sources are visible with a clear note.
- Existing dashboard sections still render when optional data is absent.
- No sensitive file contents are exposed.

## Out of Scope

- Repairing missing data.
- Running `/stats` automatically.
- Uploading diagnostics.
