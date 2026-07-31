# SERVER-05: the fleet event stream

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/rubric.md`
>
> **Depends on**: server/04
> **Blocks**: ui/03, wiring/04
> **Status**: done

## Goal

`GET /api/events` streams aggregated fleet snapshots as the run's flightlog grows, so the page reflects
a live flight without polling and without re-implementing any derivation rule in the browser.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/tail.ts` (new) — pure cursor and line-splitting helpers.
- `packages/dispatch/skills/autopilot/scripts/tail.test.ts` (new) — unit tests for them.
- `packages/dispatch/skills/autopilot/scripts/events-api.ts` (new) — the stream handler.
- `packages/dispatch/skills/autopilot/scripts/events-api.test.ts` (new) — frame formatting tests.
- `packages/dispatch/skills/autopilot/scripts/flightdeck.ts` (modify) — register the route.

## Implementation notes

The frame sequence, the snapshot payload shape, the debounce, and the reasons for streaming snapshots
rather than raw lines are all specified in the data model context file listed in Required reading.
Implement exactly that. The notes below cover the failure handling, which is where this kind of stream
normally goes wrong.

A working reference implementation of the tailing pattern exists at
`packages/monitor/skills/cockpit/scripts/sse-tailer.ts`. **Read it for the approach; do not import it.**
dispatch must not depend on monitor. That file also solves problems this task does not have, such as
serving several different files and shipping a reverse-scroll cursor. Copy the resilience model, not the
surface area.

### The server aggregates

Hold the parsed entry list in memory per connection. On every growth: read the new bytes, parse the
complete lines, append the valid ones, re-run `aggregateFleet` over the whole list, and emit one
snapshot. The browser never sees a raw entry.

Re-running aggregation over the full list rather than incrementally is intentional. A run's log is a few
hundred entries, so the cost is trivial, and an incremental fold would be a second implementation of the
pairing rules — the exact duplication this design exists to avoid.

### The file may not exist yet

This is the single most important behaviour. A user can open the page before the first agent writes
anything, and the log file is created by the first log call, not by autopilot's startup.

A missing file is **not** a 404. Returning one makes the browser's `EventSource` fail the connection
permanently, with no automatic reconnect, and the panel stays blank for the entire run. Instead: accept
the connection, immediately emit a snapshot with `logPresent: false` and no rows so the client can
render its waiting state, then re-check for the file on an interval until it appears.

### Watch first, poll as a safety net

Use `fs.watch` on the file as the low-latency signal. Run a low-frequency poll alongside it — roughly
every 2s — because `fs.watch` is not reliable on every platform and filesystem, and a stream that
silently stops updating is worse than a slightly slower one. Both paths call the same read function.

Also watch the parent directory. The file can be created after the connection opens, and a watcher
attached to a path that did not exist will never fire.

### Partial lines

An append can be observed mid-write, leaving a trailing fragment with no newline. Never parse a partial
line. Keep this logic pure and tested:

```ts
/** Split a chunk into complete lines and the trailing partial remainder. */
export function splitCompleteLines(text: string): { complete: string[]; partial: string };

/**
 * Decide how to advance after a stat. A file smaller than the cursor means it was
 * truncated or replaced, so the cursor resets to zero and the whole file is re-read.
 */
export function nextCursor(prev: number, size: number): { from: number; reset: boolean };
```

**Exactly one strategy, and it must not be mixed with the other.** The cursor advances through **every
byte read**, all the way to the file size. The trailing partial is held in memory and prepended to the
next chunk. Concretely, each pass:

1. read bytes from `cursor` to the current size
2. prepend the held partial string to that chunk
3. split into complete lines and a new partial
4. set `cursor` to the size just read
5. replace the held partial with the new one

The tempting alternative — leaving the cursor sitting before the partial *and* holding a copy — reads
those bytes twice: the next pass starts at the partial again and then prepends the saved duplicate. The
result is corrupted JSON on a split line and a double count. Pick the strategy above; do not retain the
cursor at the partial boundary.

Decode with a streaming decoder so a multi-byte UTF-8 character split across two reads is reassembled
rather than replaced with a substitution character. A `TextDecoder` created once per connection with
`{ stream: true }` on each `decode` call does this; a fresh `Buffer.toString()` per chunk does not.

On a truncation reset, clear the held partial as well as the cursor. A stale fragment prepended to a
rebuilt file's first line would corrupt it.

### Truncation and replacement

A rebuilt or rotated log can shrink. Compare size against the cursor on every pass: a smaller size means
reset the cursor to zero, clear the held partial, discard the in-memory entry list, and re-read. That is what `nextCursor`
encodes, and it is worth a direct test — it is easy to write a cursor that only moves forward and then
silently stops emitting after a rebuild.

### Malformed lines

`parseLog` already drops unreadable lines rather than aborting a trail. This stream inherits that
tolerance: a line that does not parse is skipped, is not counted in `entryCount`, and does not end the
stream. One bad write must not blank the panel.

### Debounce, heartbeat, cleanup

Debounce snapshot emission to at most one per 250ms, so a burst of appends produces one frame. Send a
`:heartbeat` comment every 25s so idle sockets are not dropped. On client disconnect, close both
watchers, clear every interval and timer, and release the entry list. A leaked watcher per reload will
exhaust file handles over a long session.

## Acceptance criteria

- [x] Connecting emits one `fleet` snapshot derived from whatever the log already holds.
- [x] Each snapshot carries the full current row set, `entryCount`, and `logPresent`.
- [x] A line appended after connect produces a new snapshot within 2s.
- [x] Connecting when the log file does not exist holds the connection open and emits a snapshot with
      `logPresent: false` and no rows.
- [x] The backlog snapshot reflects only lines that parse; malformed and blank lines are excluded from
      the rows and from `entryCount`.
- [x] A partial trailing line is not parsed; it is included once its newline arrives.
- [x] A multi-byte UTF-8 character split across two reads is reassembled intact: the resulting entry
      parses, its text is uncorrupted, and it is counted exactly once.
- [x] Truncating the file below the cursor clears the cursor, the held partial, and the entry list, then
      re-reads from the start.
- [x] The cursor advances to the full size read on every pass; no byte range is read twice.
- [x] A burst of appends within 250ms produces one snapshot, not many.
- [x] The browser receives no raw log entries; aggregation happens only on the server.
- [x] A `:heartbeat` comment is sent on an interval.
- [x] Disconnecting releases both watchers and every timer.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/` — all green, including the pure helpers.
- [x] Copy a real trail to a scratch plan directory and start the daemon against it:
      `docs/chronicle/.flightlog/run.jsonl` holds real score and note entries.
      `curl -N -s localhost:5757/api/events | head -1` shows a `fleet` frame with a populated `rows` array.
- [x] Start against a scratch plan that has a `tasks/` tree but no flightlog; attach a client and confirm
      it stays connected with a `logPresent: false` frame — no immediate exit, no 404.
- [x] With that client attached, create the log and append one entry with the flightlog CLI; confirm a
      new snapshot arrives with one row.
- [x] Append a line in two writes, splitting mid-JSON, and confirm no snapshot counts it until the
      newline lands.
- [x] Split a multi-byte character across the boundary and confirm it survives. Write an entry whose
      message contains non-ASCII text, then append it in two writes that cut **inside** one character's
      byte sequence:
      ```bash
      LINE='{"kind":"note","ts":"2026-01-01T00:00:00.000Z","task":"probe","role":"dev","agentLabel":"probe","message":"驗證多位元組"}'
      printf '%s' "$LINE" | head -c 90 >> <log>
      sleep 1
      printf '%s' "$LINE" | tail -c +91 >> <log>; printf '\n' >> <log>
      ```
      The resulting snapshot must show the message intact, with `entryCount` up by exactly one.
- [x] Append three entries within 250ms and confirm one snapshot arrives, not three.
- [x] Append a deliberately malformed line and confirm the stream continues and `entryCount` does not grow.
- [x] Truncate the file to zero, append a fresh line, and confirm the client receives a snapshot with one
      row rather than silence.
- [x] Confirm no cross-plugin import:
      `rg -n "packages/monitor" packages/dispatch/skills/autopilot/scripts/` returns nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | 404s on a missing file, or streams raw entries instead of snapshots | Streams snapshots but has no poll fallback, or stops emitting after truncation | Missing file waits with a snapshot, watch plus poll, partials held, truncation resets, malformed skipped, debounced |
| Test coverage | ×2 | No tests | Line splitting only | Splitting, cursor reset, frame formatting, live append, debounce, malformed line, missing-file path, and a multi-byte character split across reads |
| Interface & readability | ×1 | Cursor arithmetic inlined in the stream callback | Extracted but not pure, or the cursor and partial strategies are mixed | Pure `splitCompleteLines` and `nextCursor`, one consistent cursor strategy, handler thin, aggregation reused |
| Assumptions & docs | ×1 | Intervals are bare numbers | Named constants without reasons | Comments explain why a missing file is not a 404, why polling backs up the watcher, and why full re-aggregation beats an incremental fold |

## Out of scope

- Rendering any of this. The client work lives in the ui bucket.
- Streaming task-file changes. The tree endpoint is polled by the client instead; a second watcher over
  the whole tasks directory is not justified for a few dozen files.
- Delta frames. Settled in the design: full snapshots cannot desynchronise and need no replay protocol.
- Replaying a past run from a different plan. One daemon serves one tree.
