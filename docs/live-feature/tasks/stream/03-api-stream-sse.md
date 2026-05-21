# STREAM-03: `GET /api/stream` SSE transcript stream

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-sources.md`
>
> **Depends on**: panel/01
> **Blocks**: stream/04
> **Status**: done

## Goal

A new `GET /api/stream?session=<id>` endpoint streams a session's transcript over Server-Sent Events: an initial backlog of the last K entries, then live-appended entries as the session writes them.

## Files to create / modify

- `token-atlas/skills/dashboard/scripts/live.ts` (modify) — add `resolveTranscriptPath()`, `isInsideProjects()`, and `streamTranscript()` (returns a `Response` carrying an SSE `ReadableStream`).
- `token-atlas/skills/dashboard/scripts/serve-dashboard.ts` (modify) — wire the `/api/stream` route + `handleStream(req)`.

## Implementation notes

This extends the LIVE module created by the foundation task (in **Depends on**), which already defines `CLAUDE_DIR`, `PROJECTS_DIR`, and the transcript-glob helper. The full path-security contract and transcript traits are in `data-sources.md` — follow them exactly.

### Validate + resolve (security, in order)

```ts
import { relative, isAbsolute, resolve as resolvePath } from "node:path";

const UUID_RE = /^[0-9a-f-]{36}$/;

function isInsideProjects(filePath: string): boolean {
  const rel = relative(PROJECTS_DIR, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
```

`handleStream(req)`:

1. Parse `session` from the query string. If it doesn't match `UUID_RE` → `400` `{ error: "invalid session id" }`. **Validate before any filesystem access.**
2. Glob-locate `<session>.jsonl` under `PROJECTS_DIR` (reuse the foundation task's glob helper).
3. If found: `realpathSync` it and confirm `isInsideProjects(realPath)`. If it escapes → `403`.
4. If not found: the session may be brand-new (status file exists, transcript not yet written). Do **not** 404 hard — open the stream anyway and start watching the expected directory for the file to appear, OR send an empty backlog and a heartbeat until it shows up. Simplest acceptable v1: poll-resolve the glob inside the stream until the file exists, then begin tailing.

### SSE response (Bun)

Bun streams SSE via a `ReadableStream` body:

```ts
function sse(controller: ReadableStreamDefaultController, payload: object) {
  controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`);
}

const stream = new ReadableStream({
  start(controller) { /* backlog + watcher setup */ },
  cancel() { /* tear down watcher + timers */ },
});

return new Response(stream, {
  headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
  },
});
```

Enqueue strings (a `TextEncoder` is optional; Bun accepts string chunks). Each event is `data: <json>\n\n`. Heartbeats are SSE comments: `: ping\n\n`.

### Backlog → tail (byte-offset)

1. **Backlog**: read the file once, split on `\n`, take the last K complete lines (`K = 50` is a reasonable default), parse each, emit a `data:` event per parsed entry. Track the byte length read as the initial `offset`.
2. **Watch**: `fs.watch(filePath, ...)` (Node `node:fs` `watch`). On a change event, `statSync` the file for `newSize`:
   - **Truncation guard**: if `newSize < offset` (file truncated / replaced) → reset `offset = 0` and re-read from the top.
   - Read bytes `[offset, newSize)` only (open a read stream / `fs` read with start/end, or read the whole file and slice — for v1 simplicity, reading the tail slice is fine).
   - Append to a **partial-line buffer**. Split the buffer on `\n`; parse and emit every **complete** line; **carry the trailing partial line** (text after the last `\n`) in the buffer for the next change. Never `JSON.parse` a half-written line.
   - Advance `offset = newSize`.
3. **Filter**: emit events for `user`, `assistant`, and tool-result entries. Other entry types (`system`, internal) may be skipped or passed through — pick one and be consistent; passing through is simplest and lets the frontend decide.
4. **Heartbeat**: a `setInterval` (~15s) enqueues a `: ping\n\n` comment to keep the connection alive.
5. **Debounce** rapid `fs.watch` events (they can fire multiple times per write) — e.g. coalesce with a small `setTimeout`/flag so you don't read on every raw event.

### Lifecycle / teardown

- In the `ReadableStream` `cancel()` (fires on client disconnect / `EventSource.close()`), close the `fs.watch` watcher and `clearInterval` the heartbeat. Leaking watchers across reconnects will exhaust file handles.
- Wrap parse in try/catch — a malformed line must not kill the stream.

### Event payload shape

Emit the parsed transcript entry as-is (it already has `type`, message/tool fields). Optionally wrap: `{ kind: "entry", entry: <parsed> }` and `{ kind: "backlog-done" }` after the initial backlog so the client can distinguish. Keep it minimal; the consuming modal task only needs `type` + content.

### Wire the route

In `serve-dashboard.ts` dispatch, add before the static fallback:

```ts
if (url.pathname === "/api/stream") return handleStream(req);
```

`handleStream` returns the SSE `Response` (or the 400/403 error responses).

## Acceptance criteria

- [ ] `session` is validated against `^[0-9a-f-]{36}$` **before** any filesystem call; bad input → 400.
- [ ] The transcript path is realpath-confined inside `~/.claude/projects` via `isInsideProjects`; an escaping path → 403.
- [ ] A not-yet-existing transcript (new session) does not hard-404 — the stream opens and begins emitting once the file appears.
- [ ] Initial response sends the last K backlog entries, then live appends as the file grows.
- [ ] Partial-line buffer: only complete lines (up to the last `\n`) are parsed; trailing partial text is carried forward.
- [ ] Truncation guard: if file size drops below the tracked offset, offset resets to 0 and re-reads.
- [ ] Heartbeat comment (~15s) is sent; watcher + heartbeat are torn down on client disconnect.
- [ ] A malformed JSONL line is skipped without terminating the stream.

## Verification

- [ ] With the server running, get a live session id from `curl -s localhost:5938/api/live | jq -r '.sessions[0].id'`, then `curl -N "localhost:5938/api/stream?session=<id>"` streams the backlog, and typing in that Claude session produces new `data:` events within ~1s.
- [ ] `curl -s -o /dev/null -w '%{http_code}' "localhost:5938/api/stream?session=not-a-uuid"` returns `400`.
- [ ] `curl -N "localhost:5938/api/stream?session=$(uuidgen | tr A-F a-f)"` (a valid-shaped but nonexistent id) does not 404 hard — it holds the connection / heartbeats.
- [ ] Leave a stream open and idle > 15s → a `: ping` comment arrives; Ctrl-C the curl and confirm (via logs or lsof) the watcher is released.
- [ ] `bun build token-atlas/skills/dashboard/scripts/live.ts --target=bun > /dev/null` compiles clean.

## Out of scope

- Resume-on-reconnect via `Last-Event-ID` / per-event byte offset `id:` — Deferred. Reason: nice-to-have; v1 re-sends backlog on reconnect, which is acceptable.
- Per-entry token/cost annotation — Deferred. Reason: out of v1 scope.
- Any Codex transcript / rollout tailing — Deferred to v2. Reason: Claude-only for v1.
