# BRIDGE-01: Broker endpoints

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/engine-reuse.md`
>
> **Depends on**: server/01
> **Blocks**: bridge/02, bridge/03
> **Status**: todo

## Goal

The daemon gains a per-session broker: a long-poll endpoint a parked session waits on, and a respond endpoint the UI (or CLI) posts an answer to — which appends a `response` record and wakes the parked session. No flat queue: routing is keyed by `sessionId` so concurrent sessions never steal each other's events.

## Files to create / modify

- `cockpit/skills/cockpit/scripts/broker.ts` (new) — the `pendingWaits` map + wait/respond logic.
- `cockpit/skills/cockpit/scripts/serve-dashboard.ts` (modify) — wire `GET /api/wait` + `POST /api/respond`.

## Implementation notes

This adapts impeccable's broker (`~/.claude/plugins/cache/impeccable/impeccable/3.0.6/skills/impeccable/scripts/live-server.mjs`) but **fixes its flat-queue flaw** by keying on `sessionId`.

### State (in the daemon process)

```ts
// at most one outstanding wait per session (the session is parked while waiting)
const pendingWaits = new Map<string /* sessionId */, (answer: string) => void>()
```

### `GET /api/wait?session=<uuid>&token=<t>`  (long-poll)

1. Require a valid `token` (matches `daemon.json`); reject otherwise.
2. Validate `session` against `^[0-9a-f-]{36}$`.
3. Register a resolver in `pendingWaits` for that `sessionId` (replace any stale one). Return a `Promise<Response>` that resolves to `{ "answer": "..." }` when `respond` fires.
4. **Single-hop timeout** ~270s: if no answer arrives, resolve with a sentinel (e.g. `{ "answer": null, "timeout": true }`) so the caller can re-poll. Clean up the map entry on resolve/timeout/cancel.

### `POST /api/respond  { session, answer, token }`

1. Require a valid `token`.
2. Look up the session's `logPath` from `~/.cockpit/registry.json` (the registry the daemon already reads); validate it.
3. **Append a `response` record** to that session's log: `{ "type": "response", "answer": <answer>, "ts": <ISO> }` (atomic append, same as the CLI). This makes the answer part of the durable trail and streams to the UI via the existing log SSE.
4. Resolve the matching `pendingWaits.get(session)` with `answer`; delete the entry. If none is parked, still append the record but return `{ delivered: false }` (the session wasn't waiting — see caveat).

### Caveat to encode

`respond` can only **wake** a session that has a live `/api/wait` outstanding. If `pendingWaits` has no entry (turn fully ended / idle REPL), the response record is still written but no LLM is woken — return `delivered: false` so callers/UI can show "logged, but the session isn't listening right now."

## Acceptance criteria

- [ ] `GET /api/wait?session=<id>&token=<t>` holds the connection open and registers a `pendingWaits` entry.
- [ ] `POST /api/respond {session,answer,token}` appends a `response` record to the session's log AND causes the open `/api/wait` to return `{ answer }`.
- [ ] Two different sessions waiting concurrently each receive only their own answer (no cross-talk).
- [ ] `respond` with no parked wait still appends the record and returns `{ delivered: false }`.
- [ ] Missing/invalid `token` is rejected on both endpoints; invalid `session` uuid is rejected.
- [ ] `/api/wait` times out (~270s) with a re-pollable sentinel and cleans up its map entry.

## Verification

- [ ] Start the daemon. In one shell: `curl -s "localhost:5858/api/wait?session=<id>&token=<t>"` (hangs). In another: `curl -s -XPOST localhost:5858/api/respond -d '{"session":"<id>","answer":"yes","token":"<t>"}'` → the first curl returns `{"answer":"yes"}`.
- [ ] `tail -1 <project>/.cockpit/logs/<id>.jsonl | jq` shows a `response` record with `answer:"yes"`.
- [ ] `curl -s -XPOST .../api/respond -d '{"session":"<unparked-id>",...}'` returns `{"delivered":false}` and still appends the record.
- [ ] Wrong token → rejected.

## Out of scope

- The CLI that calls these (`cockpit wait` / `cockpit send`) — Deferred to the next bridge task.
- UI buttons that POST `respond` — Deferred to the UI-respond bridge task.
- Persisting `pendingWaits` across daemon restarts — not needed; a restarted daemon has no parked sessions (they re-poll).
