# BACKEND-03: Session `channel` flag

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/api-contract.md`
>
> **Depends on**: backend/01
> **Blocks**: ui/01
> **Status**: done

## Goal

`GET /api/sessions` reports, per session, whether a live channel client is
currently connected, so the UI can enable/disable the send box.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/inbox.ts` (modify) — export a `hasChannel(sessionId): boolean`.
- `packages/monitor/skills/cockpit/scripts/registry.ts` (modify) — include `channel` in each session of `sessionsPayload()`.
- `packages/monitor/skills/cockpit/scripts/registry.test.ts` (modify) — assert the flag.

## Implementation notes

"Has a live channel" = "has a currently parked `/api/inbox` poll" — tracked by the inbox broker's
`pendingInbox: Map<string, ParkedInbox>` (already built by the prerequisite inbox
task). No separate heartbeat needed — the parked long-poll *is* the liveness signal.

### In `inbox.ts`

```ts
export function hasChannel(sessionId: string): boolean {
  return pendingInbox.has(sessionId);
}
```

(`pendingInbox` is the inbox broker's `Map<string, ParkedInbox>`, populated when a channel client parks a `/api/inbox` long-poll.)

### In `registry.ts`

Find where `sessionsPayload()` builds each session view (the `SessionView` shape
with `provider`, `status`, `liveStatus`, `subagents`, …). Add:

```ts
import { hasChannel } from "./inbox";
// per session, in the mapped object:
channel: hasChannel(sessionId),
```

Add `channel: boolean` to the `SessionView` type. Only Claude sessions will ever
be `true` (Codex never spawns a channel), but the flag is derived purely from the
inbox map, so no provider special-casing is needed here.

## Acceptance criteria

- [x] `sessionsPayload()` items include `channel: boolean`.
- [x] `channel` is `true` exactly when that session has a parked inbox poll, `false` otherwise.
- [x] The `SessionView` type documents the field.
- [x] Existing registry tests still pass; a new test covers `channel` true/false.

## Verification

- [x] `bun test packages/monitor/skills/cockpit/scripts/registry.test.ts` green.
- [x] Manual: with a parked `/api/inbox` poll for a known session, `curl -s localhost:5858/api/sessions | jq '.sessions[] | {sessionId, channel}'` shows `channel: true` for it.

## Out of scope

- Using the flag to enable/disable the send box in the UI — a UI task owns it.
- Any persistence of channel state — it's purely in-memory/live.
