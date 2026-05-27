# CHANNEL-01: Channel permission relay

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/protocol.md`
>
> **Depends on**: backend/01
> **Blocks**: none
> **Status**: done (code + 22 unit tests; live relay confirmed — Allow/Deny round-trips; both Open Questions resolved empirically — see Findings)

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

- [x] `createMcpServer()` declares `claude/channel/permission`.
- [x] A `permission_request` notification results in a `POST /api/permission-request`
      carrying all four fields plus session + token. (unit-tested with mock fetch)
- [x] After the daemon returns a verdict, the channel sends
      `notifications/claude/channel/permission` with the verbatim `request_id` and
      the `behavior`. (unit-tested; the *running session proceeds/denies* half is
      gated on the live integration check below.)
- [x] The verdict wait never stalls the inbox loop — the round-trip runs off a
      fire-and-forget serialized chain (`registerPermissionRelay`), structurally
      identical to `createSerialNotifier`; the notification handler returns
      synchronously and the inbox poll's re-parking is untouched.
- [x] Findings for the two empirical checks: RESOLVED live (see Findings below).
      `protocol.md` resolution semantics + PLAN Open questions updated with the
      observed behavior.

## Verification

- [x] `bun test packages/monitor/skills/cockpit/scripts/cockpit-channel.test.ts`
      passes for the new pure helpers (22 pass / 0 fail).
- [x] Manual: launched a channel-flagged Claude session, triggered a Bash prompt;
      Allow from the cockpit UI let it run and Deny blocked it (Q, interactive).
      Headless `claude -p` relay path also exercised by the orchestrator.

## Out of scope

- The daemon endpoints and the UI modal — separate buckets.
- "Always allow" / scoped verdicts — the protocol only supports `allow | deny`.

## Findings (empirical checks) — RESOLVED live on 2026-05-27

Verified against a live `--dangerously-load-development-channels` session (Q ran
the interactive case; the orchestrator ran a headless `claude -p` case). Both
questions are now answered:

**Core relay loop — CONFIRMED.** Allow / Deny from the cockpit modal flows back
into the live session: Allow lets the tool run, Deny blocks it. (Q, interactive.)

1. **Does Claude notify the channel when a request is resolved elsewhere
   (terminal/TUI/hook)?** **NO.** When a relayed prompt is answered in the TUI,
   or resolved by an auto-approve hook, the cockpit modal is **not** told — it
   stays open until the UI's own TTL dismisses it. No
   `notifications/claude/channel/permission*` cancel/resolved method was ever
   observed. ⇒ the defensive cancel handler + `fallbackNotificationHandler` are
   confirmed dead paths in practice; the **UI 90s TTL fallback is load-bearing**,
   exactly as `ui/01` assumed. (Q, interactive.)
2. **Does a `PreToolUse` auto-approve hook suppress the `permission_request`?**
   **Mode-dependent, observed both ways:**
   - Headless `claude -p` (orchestrator): a `hook_response` fired and the tool
     ran with **no** `permission_request` reaching the channel — the hook
     short-circuited the prompt. (`permission_denials: []`, marker present.)
   - Interactive TUI (Q): a modal **did** appear and then went stale (per finding
     1, it lingered because nothing closes it) — i.e. the hook did not reliably
     suppress the channel request before the modal surfaced.
   ⇒ Either way the relay is correct, but the interactive case means an
   auto-approve user sees **ghost modals** that linger up to the 90s TTL. This is
   the known gap from the PLAN, now confirmed material for Q's setup — see the
   follow-up note in the PLAN Open questions.

Implications already baked into the design: the modal's three-source auto-close
keeps the TTL as the guaranteed closer; no protocol changes are needed.

### Orchestrator live integration check (after backend/01+02 land)

```bash
# 1. Daemon must be running (backend routes wired):
bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts
# 2. Open the cockpit UI for the session you're about to launch.
# 3. Launch a channel-flagged Claude session in this repo:
claude --dangerously-load-development-channels \
  --append-system-prompt "use the cockpit channel" \
  # (ensure plugin:monitor@q-lab-marketplace is enabled)
# 4. In that session, trigger a tool prompt, e.g.:  run `ls -la` via Bash.
# 5a. ALLOW from the cockpit modal → the Bash runs.
# 5b. Re-trigger, DENY from the modal → the tool is blocked.
# 6. EMPIRICAL Q1: answer a prompt in the TERMINAL instead and watch the
#    channel's stderr for any further `notifications/claude/channel/permission*`
#    method — record its exact name/params in protocol.md.
# 7. EMPIRICAL Q2: with a PreToolUse auto-approve hook active, observe whether a
#    `permission_request` still reaches the channel (stderr) or is suppressed.
```
