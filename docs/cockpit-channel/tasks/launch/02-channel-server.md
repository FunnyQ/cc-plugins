# LAUNCH-02: Channel MCP server

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/api-contract.md`
>
> **Depends on**: backend/01, backend/02
> **Blocks**: launch/03, launch/04
> **Status**: done

## Goal

A `cockpit-channel.ts` MCP server that Claude Code spawns over stdio: it injects
cockpit UI messages into the live session and exposes a `reply` tool that pushes
the agent's message to the cockpit UI.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/cockpit-channel.ts` (new) — the channel server.
- `packages/monitor/skills/cockpit/scripts/cockpit-channel.test.ts` (new) — unit tests for the pure parts (daemon-coord read, message framing, tool wiring) — the stdio/MCP runtime is verified manually.
- `package.json` at repo root or `packages/monitor/` (modify) — add `@modelcontextprotocol/sdk` dependency.

## Implementation notes

This is the one component using the MCP SDK. Build per `_context/api-contract.md`
("Channel server protocol") — that section has the exact capability block,
notification call, and reply-tool schema. Key wiring:

### Lifecycle

1. Resolve `sessionId` from `process.env.CLAUDE_CODE_SESSION_ID` when present; otherwise inspect ancestor process commands for Claude's `--session-id`, then fall back to the local transcript finder. If absent, log a clear stderr line and **still connect** (so the failure is visible in `/mcp` and the debug log) but treat as no-session (don't poll). Manual verification on Claude Code `2.1.150` found the env var is **not** present in channel children, so the ancestor argv fallback is required.
2. Read `~/.cockpit/daemon.json` → `{ port, token }`. If missing: for this task, log and stay idle (auto-starting the daemon is a later launch task).
3. `await mcp.connect(new StdioServerTransport())`.
4. Start the inbox pull loop (below).

### Inbox pull loop (UI → agent)

```ts
while (running) {
  const r = await fetch(`http://127.0.0.1:${port}/api/inbox?session=${sessionId}&token=${token}`);
  const { message, timeout } = await r.json();
  if (message) {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content: message, meta: { source: "cockpit" } },
    });
  }
  // timeout sentinel → just re-loop; on fetch error → short backoff (e.g. 1s) then re-loop
}
```

### Reply tool (agent → UI)

Register one tool `reply` (schema in api-contract). Its handler:

```ts
await fetch(`http://127.0.0.1:${port}/api/reply`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ session: sessionId, text, token }),
});
return { content: [{ type: "text", text: "sent" }] };
```

### `.mcp.json` for local testing

So this can be loaded with `claude --dangerously-load-development-channels server:cockpit-channel`, use a throwaway local `.mcp.json` for manual testing only — do NOT commit one (user-level `~/.claude.json` registration is a separate launch task). For this task, just note the command in the test/verification steps.

## Acceptance criteria

- [x] `cockpit-channel.ts` starts as an MCP stdio server with `experimental['claude/channel']` + `tools` capabilities and the cockpit `instructions`.
- [x] **VERIFIED: `CLAUDE_CODE_SESSION_ID` is absent in the channel child's env** when spawned by Claude Code `2.1.150`; `--session-id` is available in an ancestor command and is now the primary fallback.
- [x] **VERIFIED: a `mcp.notification('notifications/claude/channel', …)` lands in the live session and appears in its transcript jsonl** as a `type:"user"` message string containing `<channel source="cockpit-channel" source="cockpit">...</channel>`.
- [x] Pull loop injects each `/api/inbox` message and re-polls on the timeout sentinel; survives a transient fetch error with backoff.
- [x] The `reply` tool POSTs `/api/reply` with the session + token and returns a success content block.
- [x] No own HTTP port is opened (channel is a daemon client).

## Verification

- [x] `bun test packages/monitor/skills/cockpit/scripts/cockpit-channel.test.ts` green (pure parts).
- [x] Manual end-to-end (the real proof): register the server (temp `.mcp.json`), run `claude --dangerously-load-development-channels server:cockpit-channel` with the cockpit daemon up; `curl -XPOST localhost:5858/api/send-message -d '{"session":"<id>","text":"hi from cockpit","token":"<t>"}'` → "hi from cockpit" appears in the session as a `<channel>` message and the agent reacts.
- [x] In that session, get the agent to call `reply` → the reply tool posts successfully and the daemon reply stream receives the text.
- [x] `grep`/parse the session transcript jsonl to confirm both the injection and the reply tool call are recorded; channel injection is a user message string, and the reply is an assistant `tool_use` named `mcp__cockpit-channel__reply`.

## Out of scope

- Auto-starting the daemons / reconnect on daemon death — a later launch task owns that; here, missing daemon → stay idle.
- Writing the user-level `~/.claude.json` entry + launcher — a later launch task owns that.
- Permission relay (`claude/channel/permission`) — deferred to v2. Reason: not needed for chat; adds a verdict round-trip.
