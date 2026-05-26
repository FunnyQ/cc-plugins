# BACKEND-02: Reply fan-out (agent → UI)

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/api-contract.md`
>
> **Depends on**: none — foundation task
> **Blocks**: launch/02, ui/02
> **Status**: done

## Goal

The daemon accepts an agent reply from the channel and fans it live to UI
subscribers, with no new persisted file.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/reply-fanout.ts` (new) — `POST /api/reply` + `GET /api/reply/stream` SSE.
- `packages/monitor/skills/cockpit/scripts/reply-fanout.test.ts` (new) — tests.
- `packages/monitor/skills/cockpit/scripts/cockpit-server.ts` (modify) — route both paths.

## Implementation notes

Ephemeral pub/sub keyed by session. No file is written — the agent's reply is
already in the Claude transcript; this stream is live display only.

### State

```ts
type Sub = (text: string) => boolean;
const subscribers = new Map<string, Set<Sub>>(); // sessionId → live SSE writers
```

### `handleReply(req): Promise<Response>`  (`POST /api/reply`)

- Parse JSON; validate token + session; `text` non-empty string.
- Fan out to subscribers one by one. If a writer throws/returns false, remove only that subscriber and continue.
- Return `{ delivered: <successful writer count> }`.

### `handleReplyTicket(req): Promise<Response>`  (`POST /api/reply-ticket`)

- Parse JSON; validate daemon token + session.
- Return a short-lived, session-scoped ticket for a single EventSource connection.

### `handleReplyStream(req): Response`  (`GET /api/reply/stream`)

- Validate session and consume the short-lived ticket (query params). Do not put the daemon token in the EventSource URL.
- Return a `ReadableStream` with `Content-Type: text/event-stream`, `Cache-Control: no-cache`.
- On `start(ctrl)`: register a `Sub` that safely enqueues `data: ${JSON.stringify({ text })}\n\n`; send `: connected\n\n` immediately; `setInterval` ping `: ping\n\n` every 25s; on `req.signal` abort or enqueue failure, clear the interval and remove the sub from the set (delete the set if empty).

Model the SSE lifecycle on `log-stream.ts` / `transcript-stream.ts` (same daemon, same idleTimeout constraints). Use `jsonResponse` / `jsonError` for the POST.

### Wire into `cockpit-server.ts`

```ts
import { handleReply, handleReplyStream, handleReplyTicket } from "./reply-fanout";
if (url.pathname === "/api/reply") return handleReply(req);
if (url.pathname === "/api/reply-ticket") return handleReplyTicket(req);
if (url.pathname === "/api/reply/stream") return handleReplyStream(req);
```

## Acceptance criteria

- [x] `POST /api/reply` fans `text` to every open `/api/reply/stream` subscriber for that session and returns `{ delivered: <count> }`.
- [x] A reply with no subscribers returns `{ delivered: 0 }` and does not error.
- [x] The SSE removes its subscriber on client disconnect (no leak).
- [x] One broken SSE writer cannot fail the reply POST or block other subscribers.
- [x] Token/session validation matches the contract (401/400).
- [x] The daemon token is not placed in the EventSource URL; the UI uses `/api/reply-ticket`.
- [x] No file is created anywhere by this path.

## Verification

- [x] `bun test packages/monitor/skills/cockpit/scripts/reply-fanout.test.ts` green (a test can register a fake sub via the exported handler and assert it receives the text).
- [x] Manual: `curl -XPOST localhost:5858/api/reply-ticket -d '{"session":"<uuid>","token":"<t>"}'`, then `curl -N 'localhost:5858/api/reply/stream?session=<uuid>&ticket=<ticket>'`, then `curl -XPOST localhost:5858/api/reply -d '{"session":"<uuid>","text":"hello","token":"<t>"}'` → the first stream prints `data: {"text":"hello"}`.

## Out of scope

- The `reply` MCP tool that calls this endpoint — the channel-server task (launch bucket) owns it.
- Rendering replies in the dashboard — a UI task owns it.
