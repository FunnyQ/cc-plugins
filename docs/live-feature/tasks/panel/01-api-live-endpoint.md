# PANEL-01: `GET /api/live` active-session endpoint

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-sources.md`
>
> **Depends on**: none — foundation task
> **Blocks**: panel/02, stream/03
> **Status**: done

## Goal

A new `GET /api/live` endpoint returns the current Claude sessions (busy / idle / waiting), each as a unified `LiveSession` row, with stale sessions filtered out.

## Files to create / modify

- `token-atlas/skills/dashboard/scripts/live.ts` (new) — LIVE data engine: `LiveSession` type, session-read logic, `getLiveSessions()`.
- `token-atlas/skills/dashboard/scripts/serve-dashboard.ts` (modify) — wire the `/api/live` route + `handleLive()` handler into the `Bun.serve` fetch dispatch.

## Implementation notes

This task creates `live.ts` and adds the first route. The transcript-streaming endpoint is a **separate later task** that extends the same module — keep `live.ts` focused on the session list here, but leave the file structured so a stream handler can be appended.

### `LiveSession` type + read logic

Define and export `LiveSession` exactly as specified in `data-sources.md`. Copy the ~15-line `readSessionFiles()` logic from `data-sources.md` into `live.ts` — **do not** import `parseSessions()` from `api.ts`. Constants:

```ts
const CLAUDE_DIR = join(homedir(), ".claude");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const STALE_CUTOFF_MS = 10 * 60 * 1000; // 10 minutes
```

### `getLiveSessions()`

```ts
export function getLiveSessions(): LiveSession[]
```

Behavior:

1. `readSessionFiles()` → raw session objects (skip malformed files via try/catch).
2. Map each to a `LiveSession` per the mapping table in `data-sources.md`:
   - `provider: "claude"`, `statusSource: "claude-session-file"` (v1 constants).
   - `id` = `sessionId`; `projectName` = last non-empty segment of `cwd`; `status` = raw pass-through string.
   - `updatedAt` = `new Date(file.updatedAt ?? file.startedAt).toISOString()`; `ageMs` = `Date.now() - (file.updatedAt ?? file.startedAt)`; `isStale` = `ageMs > STALE_CUTOFF_MS`.
   - `transcriptPath` = first glob match for `<id>.jsonl` under `PROJECTS_DIR` (omit if none); `version` = `file.version`.
3. **Filter out stale rows** (`ageMs > STALE_CUTOFF_MS`).
4. Sort: `waiting` first, then `busy`, then `idle`, then others; tie-break by `updatedAt` descending. (Surfaces the highest-value signal at the top.)

For the transcript glob, Bun's `Glob` works well:

```ts
import { Glob } from "bun";
const g = new Glob(`**/${id}.jsonl`);
// first match under PROJECTS_DIR, scanned synchronously:
let transcriptPath: string | undefined;
for (const rel of g.scanSync({ cwd: PROJECTS_DIR, onlyFiles: true })) {
  transcriptPath = join(PROJECTS_DIR, rel);
  break;
}
```

Guard the glob with `existsSync(PROJECTS_DIR)` so a missing projects dir yields `undefined`, not a throw.

### Wire the route

In `serve-dashboard.ts`, the dispatch currently is:

```ts
async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/api/stats") return handleStats();
  return serveStatic(url.pathname);
},
```

Add `if (url.pathname === "/api/live") return handleLive();` before the static fallback, and add the handler mirroring `handleStats`:

```ts
import { getLiveSessions } from "./live.ts";

function handleLive(): Response {
  try {
    const sessions = getLiveSessions();
    return new Response(JSON.stringify({ sessions }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
```

Response envelope is `{ sessions: LiveSession[] }`. `Cache-Control: no-store` — this is live data.

### CLI smoke (optional, like `api.ts`)

Optionally add an `if (import.meta.main)` block that prints `getLiveSessions()` as JSON, so `bun scripts/live.ts` works as a quick check.

## Acceptance criteria

- [ ] `live.ts` exports `LiveSession` (type) and `getLiveSessions()`.
- [ ] `getLiveSessions()` reads `~/.claude/sessions/*.json` directly (no import of `parseSessions` from `api.ts`).
- [ ] Each row has `provider: "claude"`, `statusSource: "claude-session-file"`, absolute ISO `updatedAt`, numeric `ageMs`, boolean `isStale`, and `transcriptPath` when the JSONL exists.
- [ ] Sessions older than 10 minutes are excluded from the result.
- [ ] Malformed / mid-write session files are skipped, not fatal.
- [ ] `GET /api/live` returns `{ sessions: [...] }` as JSON with `Cache-Control: no-store`; errors return `500 { error }`.
- [ ] `/api/stats` and static serving still work (route added, not replaced).

## Verification

- [ ] `bun token-atlas/skills/dashboard/scripts/serve-dashboard.ts --no-open` then `curl -s localhost:5938/api/live | jq` shows current sessions; with a real session busy/idle/waiting, the `status` field reflects it.
- [ ] `curl -s localhost:5938/api/stats | jq '.overview' ` still returns the snapshot (no regression).
- [ ] `bun build token-atlas/skills/dashboard/scripts/live.ts --target=bun > /dev/null` compiles clean.
- [ ] Temporarily corrupt one file in `~/.claude/sessions/` (or add a junk `.json`) → `/api/live` still responds 200 and skips it.

## Out of scope

- Per-session running token / cost — Deferred. Reason: pulls in usage parsing + pricing + per-file mtime cache; keeps v1 lean. Reserve no field beyond the optional `model` already in the type.
- The SSE transcript stream — Deferred. Reason: it's a separate task that extends this same `live.ts`; this task only ships the session list.
- Any Codex source — Deferred to v2. Reason: Codex has no on-disk status field; the `provider`/`statusSource` unions reserve room only.
