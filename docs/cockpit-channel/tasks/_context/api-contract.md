# API & protocol contract

> The shared interface between the daemon (backend), the channel server (launch),
> and the dashboard (ui). All daemon endpoints bind `127.0.0.1` and are
> token-checked. Inline here so no task needs to open another.

## Auth

Every new endpoint requires the daemon token (the shared secret written to
`~/.cockpit/daemon.json` on bind). Read it fresh per request — never cache.

```ts
// pattern from broker.ts
function daemonToken(): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(cockpitHome(), "daemon.json"), "utf8"));
    return typeof raw?.token === "string" ? raw.token : null;
  } catch { return null; }
}
```

- Long-poll GET endpoints take `token` as a query param; POST endpoints take it in the JSON body.
- Browser SSE streams do **not** put the daemon token in the URL. The dashboard first POSTs for a short-lived ticket, then opens the EventSource with that ticket.
- Mismatch → `401 { error: "unauthorized" }`. Invalid/absent session → `400 { error: "invalid session" }`.
- `sessionId` is a UUID; validate with `/^[0-9a-f-]{36}$/` (same as `broker.ts`).

## Endpoints (new)

### `GET /api/inbox?session=<uuid>&token=<t>`

Long-poll the channel server parks on, waiting for a UI message for `session`.

- One outstanding poll per session (`Map<sessionId, resolver>`); a new poll replaces a stale one.
- Budget ≤ 240s (overridable via `COCKPIT_WAIT_TIMEOUT_MS`), kept under the daemon's 255s `idleTimeout`.
- On a delivered message: `200 { message: "<text>" }`.
- On timeout: `200 { message: null, timeout: true }` — a re-pollable sentinel; the client re-polls.
- Cold-start: if a message was POSTed before this poll parked, deliver it immediately from the stash.

### `POST /api/send-message  { session, text, token }`

The UI posts a barge-in message.

- Wakes the parked inbox poll for `session` if present → returns `200 { delivered: true }`.
- Else stash the text (TTL, default 60s, `COCKPIT_STASH_TTL_MS`) for the next poll hop → `200 { delivered: false }`. (Same stash rationale as `broker.ts`: the channel poll may be mid-re-poll.)
- `text` is a non-empty string; empty/missing → `400`.

### `POST /api/reply  { session, text, token }`

The channel's `reply` tool posts the agent's message for the UI.

- Fan `text` to all subscribers of the reply SSE for `session` (ephemeral — no file written).
- `200 { delivered: <n subscribers> }`. No subscribers is fine (`delivered: 0`).
- A broken/closed subscriber must be removed without failing the POST or blocking other subscribers.

### `POST /api/reply-ticket  { session, token }`

Mint a short-lived ticket for one browser SSE connection.

- Validates daemon token + session.
- Returns `200 { ticket, expiresAt }`.
- The ticket is scoped to one session and consumed by `/api/reply/stream`.

### `GET /api/reply/stream?session=<uuid>&ticket=<ticket>`

SSE the UI subscribes to for live agent replies.

- Validates session and consumes the short-lived ticket. The daemon token never appears in this URL.
- Emits `data: {"text": "..."}\n\n` per reply; a comment ping (`: ping\n\n`) every ~25s to keep the socket alive under the 255s idleTimeout.
- Content-Type `text/event-stream`, `Cache-Control: no-cache`.

### `GET /api/sessions` (extended)

`sessionsPayload()` gains a `channel: boolean` per session — true when that
session currently has a **parked inbox poll** (i.e. a live channel client). The
UI uses it to enable/disable the send box. No new endpoint; extend the existing
payload shape.

## Channel server protocol (MCP, `cockpit-channel.ts`)

Built with `@modelcontextprotocol/sdk`, stdio transport (Claude Code spawns it).

### Capability declaration

```ts
new Server(
  { name: "cockpit-channel", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} }, // registers the channel listener
      tools: {},                              // for the reply tool
    },
    instructions:
      'Messages from the cockpit dashboard arrive as <channel source="cockpit">…</channel>. ' +
      "When you want to address the user in the cockpit UI directly, call the reply tool with your message.",
  },
)
```

### Inbound injection (UI → agent)

For each message pulled from `GET /api/inbox`:

```ts
await mcp.notification({
  method: "notifications/claude/channel",
  params: { content: text, meta: { source: "cockpit" } },
});
// arrives in the session as: <channel source="cockpit">text</channel>
```

### Reply tool (agent → UI)

```ts
// ListTools → one tool:
{ name: "reply", description: "Send a message to the cockpit dashboard UI",
  inputSchema: { type: "object",
    properties: { text: { type: "string", description: "Message to show in cockpit" } },
    required: ["text"] } }
// CallTool("reply", { text }) → POST /api/reply { session, text, token } → return { content: [{ type: "text", text: "sent" }] }
```

### Session identity

The channel reads `process.env.CLAUDE_CODE_SESSION_ID` to know which session it
serves (inherited from the parent `claude` process). ⚠️ This is the #1
assumption to verify (`launch/02`). If absent, fall back is unresolved — flag it.

### Daemon coords

Read `~/.cockpit/daemon.json` for `{ port, token }`. If missing/unreadable, the
channel is inert (logs one line, keeps the session usable) — but per the
auto-start decision (`launch/03`) it instead **starts** the daemon and retries.
