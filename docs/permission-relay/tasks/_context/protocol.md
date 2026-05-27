# Protocol context — Claude Code Channels permission relay

The exact wire protocol, confirmed against the official Channels reference
(https://code.claude.com/docs/en/channels-reference). Backend, channel, and UI
tasks all depend on these shapes — they are inlined here so no task has to
re-derive them.

## Capability declaration

Permission relay is opt-in via an extra experimental capability **alongside** the
existing channel capability:

```ts
capabilities: {
  experimental: {
    'claude/channel': {},
    'claude/channel/permission': {},  // opt in to permission relay
  },
  tools: {},
}
```

**Minimum version**: Claude Code **v2.1.81+**. Earlier versions ignore the
capability silently (no `permission_request` ever arrives) — so declaring it is
safe and needs no version gate. Custom channels still require launching with
`--dangerously-load-development-channels` (research preview).

## Inbound: the permission request (session → channel)

When the running session hits a tool-permission prompt, Claude Code sends the
channel a notification:

- **method**: `notifications/claude/channel/permission_request`
- **params**:

  | field | type | meaning |
  |---|---|---|
  | `request_id` | string | 5 lowercase letters from `a–z` minus `l` (so it can't be misread as `1`/`I`). **Must be echoed verbatim** in the verdict. |
  | `tool_name` | string | e.g. `Bash`, `Write`. |
  | `description` | string | human-readable summary — identical to the local terminal dialog text. |
  | `input_preview` | string | the tool's arguments as a JSON string, truncated to ~200 chars (for `Bash` the command; for `Write` the path + a content prefix). |

The channel registers this with `mcp.setRequestHandler` / `setNotificationHandler`
(the SDK's notification-handler API) — note the current channel registers no
notification handlers yet.

## Outbound: the verdict (channel → session)

The channel returns the decision as a notification:

```ts
await mcp.notification({
  method: 'notifications/claude/channel/permission',
  params: {
    request_id: '<the exact request_id from the request>',
    behavior: 'allow' | 'deny',   // 'allow' = let the tool run; 'deny' = same as "No" in the dialog
  },
})
```

Claude Code **only accepts a verdict whose `request_id` matches** a pending
request. A verdict for an unknown/already-resolved id is ignored.

## Resolution semantics (the important nuance)

- The **local terminal dialog stays open** the whole time. Terminal and remote
  (cockpit) race; **whichever answers first wins**, and the other is dropped.
- **RESOLVED empirically (2026-05-27)**: Claude Code does **NOT** send any
  follow-up notification to the channel when a request is resolved elsewhere
  (TUI answer or auto-approve hook). The pending remote request is dropped
  silently — no `permission_cancel` / `permission_resolved` method is ever sent.
  The channel's defensive cancel handlers therefore never fire; closure of a
  resolved-elsewhere modal relies entirely on the UI's TTL fallback.
- **RESOLVED empirically (2026-05-27), mode-dependent**: a `PreToolUse`
  auto-approve hook short-circuits the prompt in headless `claude -p` (no
  `permission_request` reaches the channel), but in the interactive TUI a modal
  can still surface and then go stale. Net effect for an auto-approve user: ghost
  modals that linger until the TTL.

Because Claude Code sends no cancel/resolved signal, the UI **must** close the
modal via a **guaranteed fallback (TTL)** — there is no instant-close path to
wire (the `Later` item in the PLAN is therefore moot). See `ui/01`.

## Scope of the relay

The capability covers **tool-use approvals only**. Project-trust prompts and
MCP-server-consent prompts are **not** relayed — they appear only in the local
terminal. Do not attempt to surface those in cockpit.
