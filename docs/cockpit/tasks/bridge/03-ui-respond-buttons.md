# BRIDGE-03: UI respond buttons

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
>
> **Depends on**: ui/02, bridge/01
> **Status**: done

## Goal

In the decision-log column, a `needs_your_call` card's `options` become clickable buttons (plus a free-text field); choosing one POSTs to the broker, which wakes the parked LLM and appends the answer to the trail.

## Files to create / modify

- `cockpit/skills/cockpit/dashboard/dist/modules/decision-log.js` (modify) — add buttons + POST for needs_your_call cards.
- `cockpit/skills/cockpit/dashboard/dist/style.css` (modify) — button + answered-state styling.

## Implementation notes

Builds on the read-only decision-log column (which already renders `needs_your_call` cards, their `options` as a list, and `response` records inline).

### Behavior

For a card with `needs_your_call: true` that has **no `response` record yet** (still open):

1. Render each `options` entry as a button, plus a small free-text input + "Send" for a custom answer.
2. On click / send → `POST /api/respond` with `{ session: <selectedSessionId>, answer: <text>, token }`.
   - Get `token` from a `GET /api/daemon-info` style endpoint, or have the server inject it into the served page. **Do not hardcode.** (If no such accessor exists yet, add a minimal `GET /api/token` that returns the daemon token — localhost only.)
3. On success, disable the buttons (optimistic). The authoritative resolution arrives as a `response` record over the existing log SSE, which flips the card to its answered state (already handled by the read-only column).
4. If the POST returns `delivered: false`, show a subtle note: "Logged, but this session isn't listening right now" (the session isn't parked — see the data-model caveat).

### Reachability cue

Only show live buttons when the selected session is `active` **and** the call is the latest open one. For `ended`/read-only sessions, render the options as plain history (no buttons) — they can't be answered.

## Acceptance criteria

- [ ] An open `needs_your_call` card in an active session shows its `options` as buttons + a free-text answer field.
- [ ] Clicking a button (or sending free text) POSTs `/api/respond` with the session id, answer, and token.
- [ ] After a successful answer, a `response` record arrives via SSE and the card flips to answered (buttons gone).
- [ ] `delivered: false` shows the "not listening" note instead of a success state.
- [ ] Ended/read-only sessions show options as plain text with no buttons.
- [ ] The token is fetched at runtime, never hardcoded.

## Verification

- [ ] Daemon running; in a session, run `cockpit log --session <id> --needs-call --option "A" --option "B" --decision "pick path" --reason "ambiguous"` then `cockpit wait <id>` (background). In the SPA (Q): the card shows A / B buttons. Click "A" → `cockpit wait` returns "A", and a `response` card appears.
- [ ] Free-text answer path: type a custom answer + Send → same round-trip.
- [ ] Answer a session with no `wait` running → "not listening" note shows; a `response` record still appears.

## Out of scope

- The broker + CLI — built in the earlier bridge tasks; this task only adds the UI surface.
- Multi-call queueing — there is at most one open call per session (it's parked), so no queue is needed.
