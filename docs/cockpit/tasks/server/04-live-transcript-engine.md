# SERVER-04: Live-transcript engine

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/engine-reuse.md`
>
> **Depends on**: server/01
> **Blocks**: ui/03
> **Status**: todo

## Goal

`GET /api/transcript/stream?session=<uuid>` streams a Claude Code session transcript (backlog + live tail) from `~/.claude/projects/**/<id>.jsonl`, adapted from token-atlas's `live.ts`.

## Files to create / modify

- `cockpit/skills/cockpit/scripts/transcript-stream.ts` (new) — copy/adapt `streamTranscript` + path helpers.
- `cockpit/skills/cockpit/scripts/serve-dashboard.ts` (modify) — wire `/api/transcript/stream`.

## Implementation notes

This is a near-direct lift from `cc-plugins/token-atlas/skills/dashboard/scripts/live.ts`. Copy these (see engine-reuse.md):

```ts
function resolveClaudeTranscriptPath(id: string): string | undefined
// locate ~/.claude/projects/**/<id>.jsonl

function isInsideProjects(filePath: string): boolean
// realpath-confine inside ~/.claude/projects

function streamTranscript(/* id + SSE controller */)
// backlog (last ~50 lines, read backward in chunks, decoded once for UTF-8 safety)
// then fs.watch-tail new appends
```

### Endpoint

1. Validate `session` against `^[0-9a-f-]{36}$`.
2. `resolveClaudeTranscriptPath(session)`; if undefined → 404.
3. Confirm `isInsideProjects(path)` before opening.
4. SSE: emit backlog frames, a `backlog-done` marker (carry the initial history cursor if you also port `getTranscriptHistory`), then tail appends.

### Scope trim

- cockpit only needs the **Claude** provider (`~/.claude/projects`). **Drop the Codex branch** (`~/.codex/...`, `state_5.sqlite`, `isInsideCodexSessions`) — that's token-atlas-specific.
- Reverse-pagination (`/api/transcript` history paging) is **optional** for v1; port it only if the transcript column needs scroll-to-top history. Otherwise backlog + tail is enough.

## Acceptance criteria

- [ ] `GET /api/transcript/stream?session=<uuid>` sends a backlog of recent transcript lines then a `backlog-done` marker.
- [ ] New appends to the session's `~/.claude/projects/**/<id>.jsonl` push live frames.
- [ ] Invalid/non-uuid `session` → error; a path resolving outside `~/.claude/projects` is rejected.
- [ ] A session id with no transcript file → 404 (not a 500).
- [ ] Cancelling closes the watcher.
- [ ] No Codex code paths remain in the cockpit copy.

## Verification

- [ ] Pick a real recent session uuid from `~/.claude/projects`, start the daemon, then `curl -N "localhost:5858/api/transcript/stream?session=<uuid>"` shows backlog frames + `backlog-done`.
- [ ] `curl -N ".../api/transcript/stream?session=00000000-0000-0000-0000-000000000000"` (nonexistent) → 404.
- [ ] `grep -i codex transcript-stream.ts` returns nothing.

## Out of scope

- Rendering transcript entries (markdown, diffs, tool pairing) — Deferred to the transcript column task (renderer lives in the SPA).
- Codex provider support — Dropped. Reason: cockpit tracks Claude Code sessions only.
