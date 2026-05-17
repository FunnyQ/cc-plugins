# Task 03: Add Session And Thread Ledger

## Context

Token Atlas is a local usage dashboard for Claude Code and Codex data. It lives at `token-atlas/skills/dashboard/`.

Key files:

- Data engine: `token-atlas/skills/dashboard/scripts/api.ts`
- Frontend app logic: `token-atlas/skills/dashboard/dashboard/dist/app.js`
- Markup: `token-atlas/skills/dashboard/dashboard/dist/index.html`
- Styles: `token-atlas/skills/dashboard/dashboard/dist/style.css`
- Product context: `token-atlas/skills/dashboard/PRODUCT.md`

Claude data is read from `~/.claude/`, including stats cache, history, sessions, and project transcripts. Codex data is read from `~/.codex/state_5.sqlite` and `~/.codex/sessions/`.

Current dashboard exposes aggregate trends and project summaries, but it does not provide a row-level ledger of individual sessions or Codex threads.

## Goal

Add a searchable/sortable local ledger of recent Claude sessions and Codex threads so users can trace cost and token spikes back to concrete work units.

## Requirements

- Add a section named `Session ledger` or similarly concise.
- Rows should include:
  - timestamp or date
  - provider
  - project name/path
  - model
  - interactions/messages
  - tool calls
  - tokens
  - estimated cost
- Support at least:
  - provider filter via existing All / Claude / Codex control
  - date range via existing range control
  - sort by date, cost, or tokens
- Limit visible rows by default, for example latest 50, with a simple `show more` control if needed.
- Do not add network calls.

## Data Work

The API currently returns:

- `sessions` from Claude `~/.claude/sessions/*.json`
- aggregate Codex thread activity inside `parseCodexUsage()`, but not a public `threads` or unified ledger array.

Extend the API response with a unified `ledger` array. Suggested shape:

```json
{
  "id": "provider-specific-id-or-path",
  "provider": "claude",
  "timestampMs": 0,
  "date": "2026-05-17",
  "projectPath": "/path/to/project",
  "projectName": "project",
  "model": "claude:claude-sonnet-...",
  "interactions": 0,
  "toolCalls": 0,
  "tokens": 0,
  "costUSD": 0
}
```

For Claude, use the best available data from sessions, history, and transcript usage. If exact per-session token cost is not available, use a clearly named approximation field or leave cost null. Do not pretend approximate data is exact.

For Codex, data should come from thread rows and session summaries already parsed in `parseCodexUsage()`.

## UX Notes

- This is a ledger, not a feed. Use compact table styling.
- Keep rows scannable. Avoid giant cards.
- If cost is approximate or unavailable, label it clearly.

## Acceptance Criteria

- The API returns a stable `ledger` array without breaking existing dashboard data.
- The UI displays recent ledger rows without layout overflow on desktop and mobile.
- Provider and date filters affect visible ledger rows.
- Sorting works for date, tokens, and cost.
- Missing model/cost/project fields render as `n/a` or equivalent, not broken text.

## Out of Scope

- Opening raw transcript files.
- Deleting or editing session data.
- Full-text search inside prompts or responses.
