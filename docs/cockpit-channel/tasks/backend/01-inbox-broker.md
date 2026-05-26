# BACKEND-01: Inbox broker (UI → agent)

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/api-contract.md`
>
> **Depends on**: none — foundation task
> **Blocks**: backend/03, launch/02, ui/01
> **Status**: done

## Goal

The daemon can accept a UI barge-in message and hand it to a parked channel
long-poll for that session.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/inbox.ts` (new) — the inbox broker (handlers + in-memory state).
- `packages/monitor/skills/cockpit/scripts/inbox.test.ts` (new) — tests.
- `packages/monitor/skills/cockpit/scripts/cockpit-server.ts` (modify) — route `/api/inbox` and `/api/send-message`.

## Implementation notes

Mirror `broker.ts` closely — it already solves the exact concurrency + cold-start
problems. Do **not** invent a new pattern.

### State

```ts
type ParkedInbox = { resolve: (message: string | null) => void };
const pendingInbox = new Map<string, ParkedInbox>();           // one poll per session
const stashed = new Map<string, { text: string; expires: number }>(); // cold-start
```

- `cockpitHome()`, `daemonToken()`, the `UUID_RE`, `waitTimeoutMs()` (240s default, `COCKPIT_WAIT_TIMEOUT_MS`), and stash TTL (`COCKPIT_STASH_TTL_MS`, 60s default) follow `broker.ts` verbatim. Factor shared helpers by copying the small functions — keep `inbox.ts` self-standing (don't refactor `broker.ts`).

### `handleInbox(req): Response | Promise<Response>`  (`GET /api/inbox`)

- Validate token + session (`401` / `400` as in api-contract).
- Drain stash first: if `stashed` has an unexpired entry for this session, return `{ message }` immediately and delete it.
- Replace any existing parked resolver for the session (resolve old with `null`).
- Park a Promise: on resolve with a string → `{ message }`; on timeout (`setTimeout(waitTimeoutMs)`) → `{ message: null, timeout: true }`; clean the map entry; honor `req.signal` abort (drop the entry).

### `handleSendMessage(req): Promise<Response>`  (`POST /api/send-message`)

- Parse JSON; validate token + session; `text` must be a non-empty string (else `400`).
- If a parked inbox poll exists → delete it, `resolve(text)`, return `{ delivered: true }`.
- Else `stashed.set(session, { text, expires: Date.now() + ttl })`, return `{ delivered: false }`.

### Wire into `cockpit-server.ts`

Add beside the existing broker routes (~line 237-238):

```ts
import { handleInbox, handleSendMessage } from "./inbox";
// inside fetch():
if (url.pathname === "/api/inbox") return handleInbox(req);
if (url.pathname === "/api/send-message") return handleSendMessage(req);
```

Use `jsonResponse` / `jsonError` from `http.ts`. Tests override `COCKPIT_HOME` (and write a `daemon.json` with a known token) the way `broker.test.ts` does.

## Acceptance criteria

- [ ] `POST /api/send-message` with a valid token wakes a parked `GET /api/inbox` for the same session, which resolves with `{ message: text }`.
- [ ] A send with no parked poll stashes; the next `GET /api/inbox` drains it immediately (cold-start race covered).
- [ ] A second `GET /api/inbox` for a session replaces the first (only one park per session).
- [ ] Bad/absent token → 401; non-UUID session → 400; empty `text` → 400.
- [ ] Inbox poll resolves with `{ message: null, timeout: true }` after the (test-shortened) budget.
- [ ] Routes reachable through `cockpit-server.ts`.

## Verification

- [ ] `bun test packages/monitor/skills/cockpit/scripts/inbox.test.ts` green.
- [ ] Manual: start the daemon, `curl -s 'localhost:5858/api/inbox?session=<uuid>&token=<t>'` parks; in another shell `curl -XPOST localhost:5858/api/send-message -d '{"session":"<uuid>","text":"hi","token":"<t>"}'` returns `{"delivered":true}` and the first curl returns `{"message":"hi"}`.

## Out of scope

- The agent→UI reply direction — a separate backend task (reply fan-out) owns it.
- The `channel` boolean on `/api/sessions` — a separate backend task owns it.
