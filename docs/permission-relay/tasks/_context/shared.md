# Shared context — Permission Relay

Every task in this feature reads this file first. It freezes the conventions and
the existing code patterns the work reuses, so a task file never has to send you
hunting through the repo.

## Where the code lives

All daemon/channel scripts: `packages/monitor/skills/cockpit/scripts/`
All UI assets: `packages/monitor/skills/cockpit/dashboard/dist/` (committed as-is,
no build step; `modules/*.js` are ES modules loaded by `index.html`).

## Runtime & style conventions

- **Runtime**: Bun (TypeScript, no transpile). Use `Bun.serve`, `Bun.file`,
  `bun:sqlite`, `Bun.sleep` where relevant.
- **Types**: prefer `type` over `interface`.
- **No external npm deps** in the UI — vendor libs (petite-vue, marked, DOMPurify,
  highlight.js) are committed under `dashboard/dist/vendor/`. The daemon/channel
  may use `@modelcontextprotocol/sdk` (already a dependency).
- **Frontend**: petite-vue (not full Vue). UI modules are plain ES modules under
  `dashboard/dist/modules/`, imported from `index.html` / `app.js`.
- **Tests**: `bun test packages/monitor/skills/cockpit/scripts/`. Extract pure
  functions so logic is unit-testable without a live daemon (mirror how
  `broker.ts` / `inbox.ts` / `cockpit-channel.ts` export testable helpers).
- **Surgical changes**: match surrounding style; don't refactor unrelated code.

## The daemon (cockpit-server.ts)

- Singleton on `127.0.0.1:5858` (PID file `~/.cockpit/daemon.json`), `idleTimeout: 255`.
- Routes are registered as `if (url.pathname === "/api/...") return handleX(req);`
  inside `fetch(req)`. New endpoints are added there (see `backend/02`).
- The daemon writes only `daemon.json`; it never rewrites session log files.

## Auth — the daemon token (REQUIRED on every new endpoint)

The Channels docs are explicit: anyone who can reply through the channel can
approve/deny tool use, so **every permission endpoint must authenticate the sender.**
Read the shared secret fresh per request (so a daemon restart's new token is picked
up) exactly like the existing handlers:

```ts
function cockpitHome(): string {
  return process.env.COCKPIT_HOME || join(homedir(), ".cockpit");
}
function daemonToken(): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(cockpitHome(), "daemon.json"), "utf8"));
    return typeof raw?.token === "string" ? raw.token : null;
  } catch { return null; }
}
```

GET endpoints take `?token=<t>` in the query; POST endpoints take `token` in the
JSON body. Reject mismatches with `jsonResponse({ error: "unauthorized" }, 401)`
(import `jsonResponse as json` from `./http`). Validate `session` against
`/^[0-9a-f-]{36}$/` and 400 on a bad id.

## The long-poll + stash pattern (copy it, don't reinvent)

Both `broker.ts` and `inbox.ts` implement the identical shape; reuse it verbatim:

- A `Map<sessionId, { resolve }>` holds at most one parked poll per session.
  Re-parking resolves any stale resolver first.
- A long-poll budget under the 255s `idleTimeout` (default 240_000ms, overridable
  via `COCKPIT_WAIT_TIMEOUT_MS`) resolves with a re-pollable sentinel
  (`{ ..., timeout: true }`) before Bun drops the idle socket; the client re-polls.
- A `Map<sessionId, { ..., expires }>` **stash** absorbs the cold-start race where
  an answer arrives before the poll parks. TTL default 60_000ms, overridable via
  `COCKPIT_STASH_TTL_MS`. Drain it on the next matching poll.
- On `req.signal` abort (client hung up), resolve the parked entry with `null`.

Env-override helper shape (used throughout):

```ts
function waitTimeoutMs(): number {
  const v = parseInt(process.env.COCKPIT_WAIT_TIMEOUT_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 240_000;
}
```

## SSE fan-out pattern

The daemon already streams the decision log and transcript via SSE (see
`/api/log/stream`). A fan-out endpoint keeps a `Set` of subscriber controllers per
session and writes `data: <json>\n\n` frames; ping every ~25s to keep the socket
warm under `idleTimeout`. Reuse this shape for the permission stream.

## The channel (cockpit-channel.ts)

- A stdio MCP server spawned by the Claude CLI; a **client** of the daemon (no own
  HTTP port). It resolves its session id via `resolveClaudeSessionId()` and
  long-polls the daemon.
- `createMcpServer()` declares `capabilities.experimental['claude/channel']` and a
  `ListToolsRequestSchema` handler returning `{ tools: [] }`. Permission relay adds
  to this (see `channel/01`).
- It SENDS notifications via `mcp.notification({ method, params })` (see
  `channelNotification()`); it currently registers no notification *handlers*.
- Reconnect/backoff helpers exist: `nextReconnectDelayMs(failureCount)`,
  `ensureCockpitDaemon()`, `readDaemonCoords()`.

## Commit & verification

- One task ≈ one commit. Conventional, emoji-prefixed messages matching repo style.
- Backend/channel tasks ship with `bun test` coverage of their pure logic.
- UI tasks are verified by running the daemon and exercising the modal in a browser
  (`bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts`).
