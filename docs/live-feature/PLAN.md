# Token-Atlas LIVE Feature — Implementation Plan

> Goal: surface "live" activity in the dashboard. Two layers:
> **Level 1** — a "Live now" panel of currently-active sessions.
> **Level 2** — click a session to open a real-time stream of its full conversation.
>
> Status: **planning only** — not yet implemented.
> Scope decision: Level 1 + full-conversation stream (Claude only for v1).

## Data Sources (confirmed)

| Source | Contents | Used for |
|--------|----------|----------|
| `~/.claude/sessions/*.json` | `sessionId`, `cwd`, `status` (`busy`/`idle`/`waiting`), `updatedAt`, `pid`, `version`, `kind`, `entrypoint` | Level 1 active-session list |
| `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl` | Real-time appended transcript (entry types: `user`, `assistant`, `system`, `attachment`, `tool` results, etc.) | Level 2 stream |

**Linking:** resolve a session's transcript by globbing `~/.claude/projects/**/<sessionId>.jsonl` — no need to re-encode the cwd path ourselves (robust).

**Key win:** `status` is a real field (`busy`/`idle`/`waiting` on Claude Code v2.1.119+), so Level 1 needs no mtime guessing. Treat the value as a pass-through string and tolerate unknown values, so a future Claude status doesn't break the UI. See `LIVE_RESEARCH.md` for source details.

## Architecture Principle

- **Purely additive.** The existing `/api/stats` snapshot is untouched. LIVE is new endpoints layered on top. Zero re-architecture risk.
- Keep conventions: Bun-only, no build step, petite-vue, vendored libs, `type` over `interface`.

---

## Backend

New module `scripts/live.ts`, wired into `serve-dashboard.ts` routing.

### 1. `GET /api/live` — active session list

- Read `~/.claude/sessions/*.json`. **Do NOT import the private `parseSessions()` from `api.ts`** — copy the ~15-line read logic into `live.ts` to stay decoupled; extract a shared helper only if a third consumer appears.
- Filter out sessions whose `updatedAt` is older than ~10 min (stale / crashed).
- Return rows in the **unified `LiveSession` shape below**. v1 populates Claude rows only (`provider: "claude"`, `statusSource: "claude-session-file"`); the `provider`/`statusSource` fields exist now so adding Codex later (see Future section) needs no breaking refactor.
- Per row: `sessionId`, project name (last segment of `cwd`), `status`, **absolute `updatedAt`**, plus convenience `ageMs` and `isStale` (snapshot values for first-paint + debug), `version`.
  - Frontend formats relative time ("3m ago") client-side from `updatedAt` so it keeps ticking between 3s polls — don't rely on the server-computed `ageMs` for display.

**Unified `LiveSession` type (adopt the shape; v1 fills Claude only):**

```ts
type LiveSession = {
  provider: "claude" | "codex"; // v1: always "claude"
  id: string;
  projectName: string;
  cwd: string;
  status: "busy" | "idle" | "waiting" | string; // pass-through; tolerate unknowns
  statusSource: "claude-session-file" | "codex-app-server" | "codex-sqlite-rollout"; // v1: always "claude-session-file"
  updatedAt: string;
  ageMs: number;
  isStale: boolean;
  transcriptPath?: string;
  model?: string;
  version?: string;
};
```
- **Optional (can defer):** per-session running token/cost by reading its transcript and summing usage.
  - **Performance:** cache per-file by mtime; only recompute changed files. Do NOT re-scan every transcript on each 3s poll.
  - v1 may ship status + last-activity only; add cost later.

### 2. `GET /api/stream?session=<id>` — SSE full-conversation stream

- **Validate `session` first:** must match `^[0-9a-f-]{36}$` (UUID) — reject anything else before touching the filesystem.
- Glob-locate the transcript file from `<id>`, then **`realpath`-check it resolves inside `~/.claude/projects`** (mirror serve-dashboard.ts's `isInsideDist` → add `isInsideProjects`). Reject otherwise. Handle "file doesn't exist yet" (brand-new session) gracefully.
- Send the last K entries as an initial backlog, then `fs.watch` the file.
- On change: read only the newly-appended bytes via a tracked byte offset, parse new JSONL lines, emit `data:` events for `user` / `assistant` / tool entries.
- **Partial-line safety (critical):** keep an incomplete-line buffer — only parse up to the last `\n`, carry the trailing partial line to the next read. Never `JSON.parse` a half-written line.
- **Truncation guard:** if the file's new size < the tracked offset (truncated / replaced), reset offset to 0 and re-read.
- Lifecycle: close the watcher on client disconnect; send a heartbeat comment every ~15s to keep the connection alive; debounce rapid change events.
- **Optional — resume on reconnect:** emit `id:` = byte offset per event; on reconnect EventSource sends `Last-Event-ID`, so the server can resume from that offset instead of re-sending the whole backlog. Nice-to-have.
- Bun supports SSE natively: `new Response(ReadableStream, { headers: { "Content-Type": "text/event-stream" } })`.

---

## Frontend

New `modules/live-stream.js` + `styles/live.css`; panel markup added to `partials/dashboard.html`.

### 1. "Live now" panel (petite-vue)

- List of active sessions, each with a status indicator:
  - `busy` = animated pulse
  - `idle` = steady
  - `waiting` = **distinct attention state** (amber), shown separately from `idle` — this is the highest-value live signal ("a session is blocked waiting for your input/approval").
  - unknown status = fall back to a neutral steady dot (don't crash on new values).
- Poll `/api/live` every 3s; pause polling when the tab is hidden (`visibilitychange`).
- Indicator animation respects `prefers-reduced-motion` (consistent with hero / bloom).

### 2. Click → streaming modal

- Reuse existing `tables-and-modal.css`.
- `new EventSource("/api/stream?session=<id>")`; append entries as they arrive, auto-scroll to bottom.
- On close: `eventSource.close()`.
- Short, non-alarming notice in the modal corner: **"Shows raw local transcript content."**

---

## Decisions (resolved)

1. **Privacy** — ✅ Acceptable (server binds `127.0.0.1`, local own-data). Add a short non-alarming notice in the modal: "Shows raw local transcript content."
2. **Codex** — ✅ Deferred. v1 LIVE is **Claude only** (Codex has no equivalent status file). Revisit later.
3. **Per-session cost in v1** — ✅ Deferred. Keep the first slice lean (status + stream only). Cost pulls in usage parsing + pricing + cache invalidation — out of scope for v1.

---

## Suggested Build Order

1. `GET /api/live` + "Live now" panel (status only, incl. `waiting` attention state). Verify: panel reflects busy/idle/waiting of real sessions.
2. `GET /api/stream` SSE + click-to-open modal with backlog + live append. Verify: typing in a live Claude session appears in the modal within ~1s.
3. (Optional) per-session running token/cost in the panel.

---

## Future (v2) — Codex (deferred backlog, NOT v1)

Out of scope for v1. Full research in `LIVE_RESEARCH.md`. Captured here so v1 doesn't accidentally grow:

- **Why deferred:** Codex has no on-disk status field. Every option is a separate, substantial piece of work and would dilute the lean first slice.
- **Source priority (when we do it):**
  1. Codex **app-server** JSON-RPC/websocket — real `thread/status/changed` + turn/item streaming. Best signal, biggest lift (needs a websocket client + the app-server running).
  2. **SQLite + rollout JSONL** (`~/.codex/state_5.sqlite`, `threads.rollout_path`) — pragmatic fallback, but status is mtime-inferred (`active-inferred`/`recent`/`stale`), a worse UX than Claude's real status.
  3. **Hooks sidecar** — Token-Atlas-installed Codex hooks writing status files; careful with subagent-vs-parent stop relationships.
- **Decided constraints (keep Token-Atlas read-only):**
  - Do NOT start/manage a Codex app-server — connect only if one already exists.
  - Do NOT auto-install hooks — if ever needed, expose a separate opt-in setup command.
  - Codex archived rollouts stay out of LIVE (that's snapshot territory, already served by `/api/stats`).
- The `provider`/`statusSource` fields in `LiveSession` already reserve room for these, so adding Codex is additive, not a refactor.

---

## Task Index

This plan is decomposed into self-contained task files under `tasks/`. Each task file + the `_context/` files it lists is enough to execute it without re-reading this plan. `tasks/README.md` is the executor entry point; this section is the bridge from the plan.

**Buckets:** `panel/` = Level 1 ("Live now" panel), `stream/` = Level 2 (SSE transcript stream).

| Task | Title | Depends on |
|------|-------|------------|
| `panel/01-api-live-endpoint.md` | `GET /api/live` active-session endpoint | — (foundation) |
| `panel/02-live-now-panel.md` | "Live now" panel | `panel/01` |
| `stream/03-api-stream-sse.md` | `GET /api/stream` SSE transcript stream | `panel/01` |
| `stream/04-stream-modal.md` | Streaming transcript modal | `stream/03`, `panel/02` |

**Shared context:** `tasks/_context/shared.md` (conventions, frontend patterns, frozen decisions) + `tasks/_context/data-sources.md` (`LiveSession` type, session/transcript read logic, status semantics, path-security rules).

### Cross-bucket dependency graph

```
panel/01 ──┬──→ panel/02 ──┐
           │               ├──→ stream/04
           └──→ stream/03 ─┘
```

`panel/01` is the foundation (creates `scripts/live.ts` + `/api/live`). Once it's done, `panel/02` and `stream/03` can run in parallel. `stream/04` (the modal) needs both the panel and the SSE endpoint. Start at `panel/01`.
