# BACKEND-01: Permission broker module

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/protocol.md`
>
> **Depends on**: none — foundation task
> **Blocks**: backend/02, channel/01, ui/01
> **Status**: todo

## Goal

A new `permission.ts` daemon module that brokers a permission request from the
channel out to the UI, takes the verdict back from the UI, hands it to the
channel, and broadcasts a `resolved` event — all in-memory, keyed by session,
reusing the existing long-poll/stash/SSE patterns.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/permission.ts` (new) — the broker:
  request fan-out (SSE), verdict round-trip (long-poll), resolved broadcast.
- `packages/monitor/skills/cockpit/scripts/permission.test.ts` (new) — unit tests
  for the pure routing/stash logic.

## Implementation notes

Model this file on `broker.ts` (verdict round-trip) and `inbox.ts` (channel
long-poll) — same `cockpitHome()` / `daemonToken()` / `UUID_RE` / env-override
helpers, same `jsonResponse as json` import from `./http`. Keep all state in
module-level `Map`s (a restarted daemon simply has no pending requests; clients
re-poll). Per session there is at most one in-flight request at a time (Claude
serializes tool prompts), but key everything by `request_id` too so a stale
verdict can't resolve a newer request.

### State

```ts
type PendingRequest = {
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
  expires: number;
};
// One in-flight request per session (for the channel's verdict pull + the
// request stash for late UI subscribers).
const pendingBySession = new Map<string, PendingRequest>();

// UI SSE subscribers per session.
const streams = new Map<string, Set<ReadableStreamDefaultController>>();

// Verdict waiting to be pulled by the channel's long-poll (cold-start race:
// the verdict can arrive before the channel re-parks its pull).
type StashedVerdict = { requestId: string; behavior: "allow" | "deny"; expires: number };
const verdictStash = new Map<string, StashedVerdict>();

// At most one parked channel pull per session.
type ParkedPull = { resolve: (v: { requestId: string; behavior: "allow" | "deny" } | null) => void };
const pendingPulls = new Map<string, ParkedPull>();
```

### Endpoints (exported handlers)

```ts
// POST /api/permission-request  { session, token, request_id, tool_name, description, input_preview }
//   Channel forwards an inbound permission_request. Store as pending (with TTL),
//   then fan a {type:"request", ...} frame to the session's SSE subscribers
//   (stash the request too, so a UI tab that subscribes a moment later still sees it).
export async function handlePermissionRequest(req: Request): Promise<Response>;

// GET /api/permission-stream?session=<uuid>&token=<t>
//   UI subscribes. SSE: emits "request" frames (and replays a stashed pending
//   request on subscribe) and "resolved" frames. Ping ~25s. Clean up the
//   controller from the Set on cancel.
export function handlePermissionStream(req: Request): Response;

// POST /api/permission-verdict  { session, token, request_id, behavior }
//   UI's Allow/Deny. Validate behavior ∈ {allow,deny} and request_id matches the
//   session's pending request (ignore/也404 a stale id). Deliver to a parked pull
//   (or stash it), clear the pending request, and broadcast a
//   {type:"resolved", request_id, source:"ui"} frame to the SSE subscribers.
export async function handlePermissionVerdict(req: Request): Promise<Response>;

// GET /api/permission-pull?session=<uuid>&token=<t>
//   Channel long-polls for the verdict. Drain the stash first; else park (one per
//   session) under the wait budget; resolve with {request_id, behavior} or a
//   re-pollable {verdict:null, timeout:true}. Abort on req.signal.
export function handlePermissionPull(req: Request): Response | Promise<Response>;

// POST /api/permission-resolved  { session, token, request_id }   (best-effort)
//   Channel calls this IF it ever receives a cancel/resolved notification from
//   Claude Code (undocumented — see protocol.md). Clear the pending request and
//   broadcast {type:"resolved", request_id, source:"elsewhere"}. Safe no-op if
//   the request is already gone.
export async function handlePermissionResolved(req: Request): Promise<Response>;

// Helper for hasChannel-style liveness if needed by the UI gating (optional).
export function hasPendingRequest(sessionId: string): boolean;
```

### Rules

- Token-gate every handler (query for GET, body for POST); 401 on mismatch.
- Validate `session` with `UUID_RE`; 400 on bad id. Validate `request_id` is a
  non-empty string and `behavior ∈ {"allow","deny"}` on the verdict.
- TTL on `pendingBySession` and `verdictStash` via `COCKPIT_STASH_TTL_MS`
  (default 60_000). Pull budget via `COCKPIT_WAIT_TIMEOUT_MS` (default 240_000).
- A verdict whose `request_id` ≠ the session's pending request id is rejected
  (so a late UI click on a superseded card can't resolve a new request).

## Acceptance criteria

- [ ] `permission.ts` exports the six handlers above plus any pure helpers.
- [ ] `POST /api/permission-request` fans a `request` SSE frame to a subscribed
      `GET /api/permission-stream`, and a tab subscribing just after still receives
      the pending request (stash replay).
- [ ] `POST /api/permission-verdict` wakes a parked `GET /api/permission-pull` with
      `{request_id, behavior}` and emits a `resolved` SSE frame.
- [ ] A verdict arriving before the pull parks is stashed and delivered on the next pull.
- [ ] A verdict with a mismatched/stale `request_id` is rejected and resolves nothing.
- [ ] Every handler returns 401 on a bad token and 400 on a bad session id.

## Verification

- [ ] `bun test packages/monitor/skills/cockpit/scripts/permission.test.ts` passes,
      covering: request→stream fan-out, verdict→pull wake, cold-start stash,
      stale-request-id rejection, and auth/validation failures.
- [ ] `bun test packages/monitor/skills/cockpit/scripts/` (full suite) stays green.

## Out of scope

- Wiring the routes into `cockpit-server.ts` — handled separately. Reason: keep
  the module and its tests isolated from the server bootstrap.
- The channel-side notification handling and the UI — separate buckets.
