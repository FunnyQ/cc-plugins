# CHANNEL-01: Channel permission relay

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/protocol.md`
>
> **Depends on**: backend/01
> **Blocks**: none
> **Status**: todo

## Goal

Teach `cockpit-channel.ts` to relay permission prompts: declare the capability,
receive a `permission_request` notification, forward it to the daemon, wait for
the verdict, and send the verdict back into the live session.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/cockpit-channel.ts` (modify) — capability
  declaration, notification handler, verdict round-trip, defensive cancel handling.
- `packages/monitor/skills/cockpit/scripts/cockpit-channel.test.ts` (modify/extend)
  — unit-test the pure helpers (request→POST payload mapping, verdict→notification
  params mapping).

## Implementation notes

### Declare the capability

In `createMcpServer()`, add the permission capability beside the existing one:

```ts
capabilities: {
  experimental: {
    "claude/channel": {},
    "claude/channel/permission": {},
  },
  tools: {},
}
```

### Handle the inbound request

Register a notification handler for `notifications/claude/channel/permission_request`
(use the SDK's notification-handler registration; the channel currently registers
only a `ListToolsRequestSchema` *request* handler, so this is new). On receipt:

1. Read `request_id`, `tool_name`, `description`, `input_preview` from `params`.
2. POST them to the daemon:
   `POST http://127.0.0.1:<port>/api/permission-request`
   `{ session: <sessionId>, token: <daemonToken>, request_id, tool_name, description, input_preview }`
   (reuse `readDaemonCoords()` for `port`/`token`; the session id is the resolved
   `sessionId` the channel already holds).
3. Then obtain the verdict — long-poll the daemon:
   `GET /api/permission-pull?session=<sessionId>&token=<t>`, re-polling on the
   `{verdict:null, timeout:true}` sentinel, until it returns `{request_id, behavior}`.
4. Send the verdict into the session:

```ts
await mcp.notification({
  method: "notifications/claude/channel/permission",
  params: { request_id, behavior },  // request_id echoed verbatim
});
```

Run this off a fire-and-forget serialized chain like `createSerialNotifier` so a
slow verdict wait never blocks the existing inbox loop (the inbox poll must keep
re-parking — `hasChannel` depends on it). The verdict pull is independent of the
inbox poll; do not fold one into the other.

### Defensive cancel handling (best-effort — see protocol.md)

It is **undocumented** whether Claude Code sends a follow-up notification when the
request is resolved elsewhere. Register a handler defensively: if a notification
arrives whose method looks like a permission cancel/resolved (probe the actual
method name empirically during this task — try observing real traffic with a
terminal answer), forward it as
`POST /api/permission-resolved { session, token, request_id }` so the UI can close
instantly. If no such notification ever fires, this path is simply dead code and
the UI's own TTL fallback handles closure. **Do not block the design on it.**

### Empirical checks to run during this task (record findings in the PR)

- Answer a relayed prompt in the **terminal** and watch whether the channel
  receives any further notification (and its exact method/params). Update
  `protocol.md` and the PLAN Open questions with the finding.
- With Q's `PreToolUse` auto-approve hook active, observe whether a
  `permission_request` still reaches the channel or is suppressed.

## Acceptance criteria

- [ ] `createMcpServer()` declares `claude/channel/permission`.
- [ ] A `permission_request` notification results in a `POST /api/permission-request`
      carrying all four fields plus session + token.
- [ ] After the daemon returns a verdict, the channel sends
      `notifications/claude/channel/permission` with the verbatim `request_id` and
      the `behavior`, and the running session's tool call proceeds / is denied.
- [ ] The verdict wait never stalls the inbox loop (send-box stays live during a
      pending permission).
- [ ] Findings for the two empirical checks are recorded (and `protocol.md` /
      PLAN Open questions updated if behavior is observed).

## Verification

- [ ] `bun test packages/monitor/skills/cockpit/scripts/cockpit-channel.test.ts`
      passes for the new pure helpers.
- [ ] Manual: launch a channel-flagged Claude session
      (`--dangerously-load-development-channels` with `plugin:monitor@q-lab-marketplace`),
      trigger a tool that prompts (e.g. a Bash command), and confirm an Allow from
      the cockpit UI lets it run and a Deny blocks it.

## Out of scope

- The daemon endpoints and the UI modal — separate buckets.
- "Always allow" / scoped verdicts — the protocol only supports `allow | deny`.
