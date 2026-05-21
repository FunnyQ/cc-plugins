# Data sources — Claude LIVE

> Read alongside `shared.md`. This file pins the on-disk data contract for LIVE: the session-status source, the transcript source, the unified row type, status semantics, and the path-security rules. Everything here is Claude-only for v1.

## Two sources, two roles

| Source | Path | Contents | Used for |
|--------|------|----------|----------|
| Session status files | `~/.claude/sessions/*.json` | one JSON file per running session: `pid`, `sessionId`, `cwd`, `status`, `updatedAt`, `startedAt`, `version`, `kind`, `entrypoint` | Level 1 active-session list |
| Transcript JSONL | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | append-only JSONL, one transcript event per line | Level 2 stream |

The two are linked by `sessionId`: the transcript filename **is** the session UUID. Resolve a session's transcript by globbing `~/.claude/projects/**/<sessionId>.jsonl` — do **not** try to re-encode the cwd path yourself (the encoding is lossy/brittle; the glob is robust).

`~/.claude` is `join(homedir(), ".claude")`. In `api.ts` this is `CLAUDE_DIR`, with `SESSIONS_DIR = join(CLAUDE_DIR, "sessions")`. Use `homedir()` from `node:os`.

## Session file shape (on disk)

Observed fields (confirmed locally and by `claude-busy-monitor` for Claude Code v2.1.119+):

```ts
// Raw shape of each ~/.claude/sessions/<pid>.json
type ClaudeSessionFile = {
  pid: number;
  sessionId: string;
  cwd: string;
  status: "busy" | "idle" | "waiting" | string; // pass-through; tolerate unknowns
  startedAt: number;        // epoch ms
  updatedAt?: number;       // epoch ms — may be absent on very old files
  version?: string;
  kind?: string;
  entrypoint?: string;
};
```

The filename stem is the `pid`, not the session id — read `sessionId` from the JSON body, never from the filename.

## Session-read logic to copy into `live.ts`

Do **not** import `parseSessions()` from `api.ts`. Copy this ~15-line shape (the existing `parseSessions` is the authoritative reference for the read pattern — `readdirSync` + per-file `JSON.parse` guarded against malformed files):

```ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CLAUDE_DIR = join(homedir(), ".claude");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");

function readSessionFiles(): ClaudeSessionFile[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const out: ClaudeSessionFile[] = [];
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
      if (data && typeof data.sessionId === "string") out.push(data);
    } catch {
      // skip malformed / partially-written file
    }
  }
  return out;
}
```

A session file may be mid-write — always `try/catch` the parse and skip on failure (never let one bad file 500 the endpoint).

## Unified `LiveSession` row type (the `/api/live` contract)

Adopt this exact shape. v1 fills Claude rows only; the `provider` / `statusSource` unions reserve room for Codex without a later breaking refactor.

```ts
export type LiveSession = {
  provider: "claude" | "codex";              // v1: always "claude"
  id: string;                                 // sessionId
  projectName: string;                        // last path segment of cwd
  cwd: string;
  status: "busy" | "idle" | "waiting" | string; // pass-through; tolerate unknowns
  statusSource:
    | "claude-session-file"
    | "codex-app-server"
    | "codex-sqlite-rollout";                 // v1: always "claude-session-file"
  updatedAt: string;                          // ISO 8601, absolute
  ageMs: number;                              // now - updatedAt, snapshot for first-paint/debug
  isStale: boolean;                           // ageMs > STALE_CUTOFF_MS
  transcriptPath?: string;                    // resolved via glob; may be absent if not yet on disk
  model?: string;
  version?: string;
};
```

Mapping from a session file to a row:

- `provider` = `"claude"`, `statusSource` = `"claude-session-file"` (constants for v1).
- `id` = `sessionId`.
- `projectName` = last segment of `cwd` (`cwd.split("/").filter(Boolean).at(-1) ?? cwd`).
- `status` = the raw `status` string, untouched.
- `updatedAt` = `new Date(file.updatedAt ?? file.startedAt).toISOString()` — always absolute ISO.
- `ageMs` = `Date.now() - (file.updatedAt ?? file.startedAt)`.
- `isStale` = `ageMs > STALE_CUTOFF_MS`.
- `transcriptPath` = glob result for `~/.claude/projects/**/<id>.jsonl` (first match), else omit.
- `version` = `file.version`.

## Status values

- `busy` — the agent is actively working. UI: animated pulse dot.
- `idle` — session alive, not working. UI: steady neutral-positive dot.
- `waiting` — **blocked on the user** (input/approval). UI: distinct **amber** attention dot, listed apart from `idle`. Highest-value signal.
- _anything else_ — unknown future status. UI: neutral steady dot. Never throw.

## Stale cutoff

```ts
const STALE_CUTOFF_MS = 10 * 60 * 1000; // 10 minutes
```

`/api/live` drops rows where `ageMs > STALE_CUTOFF_MS` (crashed / abandoned sessions). `isStale` is still computed per row for debugging, but stale rows are filtered before the response — so in practice every returned row has `isStale: false` unless you choose to surface a grace band. Keep it simple: filter stale, return the rest.

## Transcript file traits (for the stream)

- One file per session; filename is the session UUID + `.jsonl`.
- Append-only, one JSON event per line. Entry objects carry `type` (`user`, `assistant`, `system`, `tool` results, `attachment`, …), plus `sessionId`, `cwd`, `timestamp`, and message/tool payloads. Assistant entries include `message.usage` token fields (unused in v1).
- A brand-new session may have a session-status file before its transcript file exists — the stream must handle "file not on disk yet" gracefully (wait for it to appear, or report empty backlog).

## Path-security rules (stream endpoint)

These are non-negotiable for the stream endpoint that opens a transcript by id:

1. **Validate the id first**, before touching the filesystem: it must match `^[0-9a-f-]{36}$` (UUID shape). Reject anything else with a 400 — do not glob on unvalidated input.
2. **Glob-locate** the transcript: `~/.claude/projects/**/<id>.jsonl`.
3. **Realpath-confine** the result: resolve symlinks and confirm the real path is inside `~/.claude/projects`. Mirror the existing `isInsideDist` guard in `serve-dashboard.ts` — relative path from the projects root must be non-empty, must not start with `..`, and must not be absolute. Reject (403/404) otherwise. Add this as `isInsideProjects(filePath)`.
4. Server already binds `127.0.0.1` only — keep it that way.

Reference guard to mirror (`isInsideDist`, from `serve-dashboard.ts`):

```ts
function isInsideDist(filePath: string): boolean {
  const rel = relative(DIST, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
```
