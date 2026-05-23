# SERVER-03: Decision-log SSE

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/engine-reuse.md`
>
> **Depends on**: server/02
> **Blocks**: ui/02
> **Status**: todo

## Goal

`GET /api/log/stream?project=<abs>&session=<id>` streams a session's decision log: a backlog of existing records, then live appends, via Server-Sent Events.

## Files to create / modify

- `cockpit/skills/cockpit/scripts/log-stream.ts` (new) — SSE tail of a decision JSONL file.
- `cockpit/skills/cockpit/scripts/serve-dashboard.ts` (modify) — wire `/api/log/stream`.

## Implementation notes

Same SSE shape as the transcript stream (engine-reuse.md), but the watched root is the **project's `.cockpit/logs/`**, not `~/.claude/projects`.

### Resolve + confine

1. Validate `session` against `^[0-9a-f-]{36}$`.
2. Resolve `logPath = <project>/.cockpit/logs/<session>.jsonl`.
3. **Confine**: `realpath` the resolved file and confirm it sits inside `<project>/.cockpit/logs/` (reject path traversal). Prefer cross-checking `project`+`session` against the registry entry the daemon already exposes rather than trusting the query param blindly.

### Stream

```
on connect:
  read all existing lines  → for each, emit  data: <json-line>\n\n
  emit a marker            → event: backlog-done\n data: {}\n\n
  fs.watch(logPath)        → on append, read only the new lines, emit each as a data frame
on cancel:
  close the watcher
```

- Parse line-by-line; **skip malformed lines** (don't kill the stream).
- The records are already JSON (goal record then decision records) — pass them through; the UI distinguishes `type: "goal"` vs `"decision"` and highlights `needs_your_call`.
- Track byte offset / line count so appends emit only new lines (a naive "re-read tail" is acceptable for v1 file sizes, but prefer offset tracking).

Return a `Response` with `Content-Type: text/event-stream`, `Cache-Control: no-cache`, body = `ReadableStream`.

## Acceptance criteria

- [ ] Connecting emits one frame per existing record (goal + decisions), then a `backlog-done` marker.
- [ ] Appending a record with `cockpit log` pushes a new frame to the connected client within ~1s.
- [ ] A malformed line in the file is skipped; subsequent valid records still stream.
- [ ] An invalid/non-uuid `session`, or a path resolving outside `<project>/.cockpit/logs/`, returns an error (no file read).
- [ ] Cancelling the request closes the file watcher (no leaked watchers).

## Verification

- [ ] Seed a log via the cockpit CLI, start daemon, then `curl -N "localhost:5858/api/log/stream?project=<abs>&session=<id>"` shows backlog frames + `backlog-done`.
- [ ] While the curl is open, run `cockpit log ...` in that project → a new `data:` frame appears.
- [ ] `curl -N ".../api/log/stream?session=not-a-uuid"` → error response, no crash.

## Out of scope

- Rendering the records (badges, needs_your_call styling) — Deferred to the decision-log column (UI).
- Replying to `needs_your_call` — handled by the bridge bucket (broker + `respond`). This endpoint only streams records out; it doesn't accept answers.
