# UI-02: Decision-log column

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/engine-reuse.md`
>
> **Depends on**: ui/01, server/03
> **Blocks**: —
> **Status**: todo

## Goal

The middle column renders the selected session's decision trail live: the goal record at the top, then each decision as a card, with `needs_your_call` records visually flagged as handoff moments.

## Files to create / modify

- `cockpit/skills/cockpit/dashboard/dist/modules/decision-log.js` (new) — EventSource client + rendering for the decision column.
- `cockpit/skills/cockpit/dashboard/dist/app.js` (modify) — mount the column, pass `selectedProject` + `selectedSessionId`.
- `cockpit/skills/cockpit/dashboard/dist/style.css` (modify) — decision-card + needs_your_call styling.

## Implementation notes

### Data source

Open an `EventSource` to `/api/log/stream?project=<selectedProject>&session=<selectedSessionId>` (the decision-log SSE endpoint). Re-open when the selection changes; close the previous one.

Frames are JSON records (see data-model.md):
- `type: "goal"` → render once at the top as the **session goal** header (`session_goal`). The project goal is shown by the info column, not here.
- `type: "decision"` → append a card.
- `type: "response"` → render inline right after the most recent `needs_your_call` card (Q's answer to that handoff).
- `backlog-done` marker → flip a "loaded" flag (hide skeleton).

### Decision card

Each card shows:
- `decision` (the headline — what was done).
- `reason` (why — the part a diff can't show).
- `tradeoff` if non-empty (muted, "gave up: …").
- `files` if non-empty (one monospace chip per path).
- `timestamp` (relative, e.g. "2m ago").

### `needs_your_call` styling

When `needs_your_call: true`, render the card as a **handoff marker** — distinct accent (e.g. left border + badge "🕹 needs your call"). This is the moment autopilot hands back the stick.

- If `options` is non-empty, render them as a plain list inside the card (read-only here). Turning them into clickable buttons that reply to the LLM is the **bridge** bucket's job — this task only displays.
- Once a `response` record arrives for it, show the answer inline and drop the "open" styling (resolved).
- Pre-render each card's HTML once on receipt and cache it (keyed by a stable per-record key) to avoid re-rendering on every reactive update — same discipline as the transcript renderer.
- Auto-scroll to newest only when the column is bottom-pinned.
- Empty state: "No decisions logged yet."

## Acceptance criteria

- [ ] Selecting a session opens the log SSE and renders the goal record (`session_goal`) as the column header.
- [ ] Each decision appears as a card with `decision`, `reason`, optional `tradeoff`, a chip per `files` entry, and a relative timestamp.
- [ ] A `needs_your_call: true` record is visually distinct (handoff badge/accent) and lists its `options` (read-only).
- [ ] A `response` record renders inline after its needs_your_call card and marks it resolved.
- [ ] Appending a decision (`cockpit log`) makes a new card appear live without reload.
- [ ] Switching sessions closes the old EventSource and loads the new session's trail.
- [ ] Empty/missing log shows the empty state, not an error.

## Verification

- [ ] Daemon running + seeded session: load the SPA (Q), select the session → goal header + existing decisions render.
- [ ] Run `cockpit log --session <id> --decision "X" --reason "Y" --needs-call` → a flagged card appears live.
- [ ] Switch to another session and back → no duplicate/stale cards; console shows the old EventSource closed.

## Out of scope

- Clickable option buttons + sending the answer back to the LLM — that's the bridge bucket; this task renders options read-only.
- Transcript / info columns — Deferred to the transcript and info column tasks.
