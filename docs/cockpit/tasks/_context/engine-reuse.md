# Engine reuse — copy the pattern, don't abstract

> cockpit is an **independent codebase**. Do **not** import from token-atlas or extract a shared lib (premature at two consumers). **Copy** the proven pieces into `cockpit/` and adapt. The references below are verification pointers + what to copy.

## Source files (read to copy, then own your copy)

- `cc-plugins/token-atlas/skills/dashboard/scripts/serve-dashboard.ts` — Bun HTTP server skeleton.
- `cc-plugins/token-atlas/skills/dashboard/scripts/live.ts` — transcript streaming + path security.
- `cc-plugins/token-atlas/skills/dashboard/dashboard/dist/modules/dashboard-app.js` — the transcript **renderer** (markdown, tool pairing, diffs, syntax highlight).
- `cc-plugins/token-atlas/skills/dashboard/dashboard/dist/styles/live.css` — live-stream styling.
- `cc-plugins/token-atlas/skills/dashboard/dashboard/dist/vendor/` — copy `petite-vue.es.js`, `marked.esm.js`, `purify.es.mjs`, `highlight.esm.js` (skip `chart.umd.js`).

## Server skeleton — from `serve-dashboard.ts`

Helpers to copy and keep:

```ts
function parsePort(): number            // reads --port from argv, default → 5858 for cockpit
function killPort(port: number): void   // frees a port if needed
function mimeFor(path: string): string
function isInsideDist(filePath: string): boolean   // confine static serving to dashboard/dist
function serveStatic(pathname: string): Response
```

Route table shape (`Bun.serve({ fetch })`):

```ts
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/api/projects") return handleProjects()
    if (url.pathname === "/api/sessions") return handleSessions()
    if (url.pathname === "/api/log/stream") return handleLogStream(req)
    if (url.pathname === "/api/transcript/stream") return handleTranscriptStream(req)
    return serveStatic(url.pathname)
  },
})
```

JSON helpers to copy from `live.ts`:

```ts
function jsonResponse(payload: object, status = 200): Response
function jsonError(err: unknown, status = 500): Response
```

## Transcript streaming — from `live.ts`

Copy and adapt these for `/api/transcript/stream` (cockpit streams a Claude Code session transcript exactly like token-atlas does):

```ts
function resolveClaudeTranscriptPath(id: string): string | undefined
// finds ~/.claude/projects/**/<id>.jsonl for a session uuid

function isInsideProjects(filePath: string): boolean
// realpath-confines a path inside ~/.claude/projects (security gate)

function streamTranscript(/* id, response controller */): /* SSE */
// sends a backlog (last ~50 lines, read backward, decoded once for UTF-8 safety)
// then fs.watch-tails new appends as SSE frames
```

**Security gate (mandatory)**: validate the session id against `^[0-9a-f-]{36}$`, resolve the path, then confirm `isInsideProjects()` before opening. Same pattern for any file served by id.

## SSE pattern (both log + transcript streams)

- Return a `Response` whose body is a `ReadableStream`; push `data: <json>\n\n` frames.
- On connect: send a **backlog** (existing lines), then a marker frame (e.g. `event: backlog-done`), then **tail** new appends via `fs.watch` on the file.
- Clean up the watcher when the stream is cancelled.
- The **decision-log SSE** (`server/03`) tails `<project>/.cockpit/logs/<id>.jsonl`; the **transcript SSE** (`server/04`) tails `~/.claude/projects/**/<id>.jsonl`. Same mechanism, different root + different security confinement.

## Transcript renderer — from `dashboard-app.js`

For `ui/03`, copy the rendering logic (don't rebuild):

- Each entry is pre-rendered to HTML **once** on receipt (cache on the entry, keyed by a stable per-line key) to avoid re-running markdown on every reactive update.
- Segments: prose → `marked` then `DOMPurify.sanitize` (GFM tables + new-tab-safe links); `thinking` → muted "💭 thinking" badge; `tool_use` / `tool_result` / JSON → escaped `<pre>` highlighted with `highlight.js`; `Read` results → line-number gutter; file edits (`Edit`/`MultiEdit`/`Write`) → inline color-coded diffs.
- Tool calls + results paired by `tool_use_id` (`reconcileToolResults()`): merge a `tool_result`-only entry into the entry holding its `tool_use`, drop the standalone bubble.
- Only conversation types stream (allowlist) — filter session-metadata noise (`file-history-snapshot`, `queue-operation`, `last-prompt`, …).
- Auto-scroll only when bottom-pinned.

Lift only what the **live transcript column** needs; cockpit has no overview/charts/heatmap panels, so ignore the analytics half of `dashboard-app.js`.
