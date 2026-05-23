# SERVER-02: Registry → projects & sessions API

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/engine-reuse.md`
>
> **Depends on**: server/01, kernel/02
> **Blocks**: server/03, ui/01
> **Status**: todo

## Goal

The daemon reads `~/.cockpit/registry.json`, derives active-vs-ended status per session, and exposes `GET /api/projects` and `GET /api/sessions` for the SPA.

## Files to create / modify

- `cockpit/skills/cockpit/scripts/registry.ts` (new) — registry read + status derivation.
- `cockpit/skills/cockpit/scripts/serve-dashboard.ts` (modify) — wire `/api/projects` + `/api/sessions`.

## Implementation notes

### Read + status

```ts
type RegistryEntry = { project: string; sessionId: string; logPath: string; lastHeartbeat: string }
type SessionStatus = "active" | "ended"

const STALE_MS = 10 * 60 * 1000 // 10 min — matches token-atlas live filtering

function readRegistry(): RegistryEntry[]      // ~/.cockpit/registry.json, default []
function statusOf(e: RegistryEntry): SessionStatus
  // active if (now - max(lastHeartbeat, logFile mtime)) < STALE_MS, else ended
```

- Tolerate a missing/corrupt registry → return `[]`.
- Use the log file's mtime as a fallback signal alongside `lastHeartbeat` (a live session appends without re-registering).

### `GET /api/sessions`

Return every registered session with derived status, **active first**:

```json
{
  "sessions": [
    { "project": "/abs/path", "sessionId": "uuid", "logPath": "/abs/.../<id>.jsonl",
      "status": "active", "lastHeartbeat": "ISO", "sessionGoal": "…", "projectGoal": "…" }
  ]
}
```

- `sessionGoal` / `projectGoal`: read line 1 (goal record) of `logPath` if present; tolerate missing.

### `GET /api/projects`

Group sessions by `project`:

```json
{
  "projects": [
    { "project": "/abs/path", "projectGoal": "…", "activeCount": 1, "sessionCount": 3 }
  ]
}
```

- `projectGoal`: read `<project>/.cockpit/project-meta.md` frontmatter `project_goal` (the single source — goal records no longer carry it); empty string if absent.

Use `jsonResponse` / `jsonError` (copied into the daemon from `live.ts`). Sort active projects/sessions first.

## Acceptance criteria

- [ ] `GET /api/sessions` returns all registered sessions, each with `status` ∈ {`active`,`ended`}, sorted active-first.
- [ ] A session whose `lastHeartbeat` + log mtime are both older than 10 min reports `ended`; a freshly-written one reports `active`.
- [ ] Each session includes `sessionGoal`/`projectGoal` read from its goal record (or empty when absent).
- [ ] `GET /api/projects` groups sessions by `project` with `activeCount`/`sessionCount` and a `projectGoal`.
- [ ] Missing/corrupt `registry.json` yields `{ "sessions": [] }` / `{ "projects": [] }`, not a 500.

## Verification

- [ ] Seed via the cockpit CLI (`cockpit start` in two scratch projects), start the daemon, then `curl -s localhost:5858/api/sessions | jq '.sessions[].status'` shows `active`.
- [ ] Hand-edit a registry entry's `lastHeartbeat` to >10 min ago and touch its log mtime back → that session reports `ended`.
- [ ] `curl -s localhost:5858/api/projects | jq` shows the grouped projects with counts.

## Out of scope

- Streaming log/transcript content — Deferred to the SSE streaming tasks.
- Watching files for live UI updates — `/api/sessions` is a snapshot polled by the SPA; the live push is the SSE endpoints' job.
