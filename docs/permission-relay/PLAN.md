# Permission Relay — approve/deny tool prompts from the cockpit UI

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-05-27

## Overview

Make the cockpit dashboard able to **answer a running Claude Code session's
tool-permission prompts** (Bash, Write, …). When the session asks "allow this
tool?", a modal appears in cockpit; the user clicks Allow/Deny and the verdict
rides back into the live turn — no switching to the terminal. Built on Claude
Code's official **Channels** permission relay capability, reusing the cockpit
daemon's existing long-poll + SSE machinery.

## Goals

- Surface a session's tool-permission prompt in the cockpit UI as a modal.
- Round-trip an Allow/Deny verdict back into the live session via the channel.
- Close the modal gracefully when the request is resolved by **any** path
  (the user here, the local terminal, or an auto-approve hook) — never a zombie card.
- Pull the user's attention back when a request arrives (the agent hard-blocks
  until answered): modal + browser notification + tab title flash / favicon badge.

## Non-goals

- **Migrating `needs_your_call` onto this modal** — out of scope here. The modal
  is built reusable so a later effort can adopt it, but this spec does not touch
  the existing `needs_your_call` flow.
- **Codex** — Codex has no channel mechanism; permission relay is Claude-only.
- **Project-trust / MCP-server-consent dialogs** — the relay capability covers
  tool-use approvals only; those dialogs appear in the local terminal only.
- **"Always allow" / scoped or remembered permissions** — the protocol's verdict
  is strictly `allow | deny` per request. No persistence, no scoping.
- **Dropping `--dangerously-load-development-channels`** — blocked on Anthropic
  GA-ing Channels; out of our control.

## Context

The cockpit channel today is UI→agent text only: a send box injects a
`<channel>` message into the live turn, and the agent's reply rides the
transcript. `cockpit-channel.ts` advertises `capabilities.experimental['claude/channel']`
and exposes no tools. The daemon (`cockpit-server.ts`, singleton on port 5858)
already runs two close analogues of what permission relay needs:

- **`broker.ts`** — `/api/wait` + `/api/respond`: a parked session long-polls for
  an answer; the UI POSTs it; routing is a `sessionId`-keyed `Map` with a
  TTL stash for the cold-start race. This is the shape of the **verdict round-trip**.
- **`inbox.ts`** — `/api/inbox` (channel long-poll) + `/api/send-message` (UI POST):
  the channel pulls UI text. This is the shape of the **channel-side verdict pull**.

Permission relay is largely *assembling these existing patterns in the reverse
direction* (session→UI for the request, UI→session for the verdict) plus one new
capability declaration and one new notification handler on the channel.

**Two protocol details are undocumented** (confirmed against the Channels
reference): whether Claude Code notifies the channel when a request is resolved
elsewhere, and whether a `PreToolUse` auto-approve hook suppresses the channel
`permission_request`. The design does **not** depend on either — see Open
questions and the auto-close lifecycle in `ui/01`.

## Requirements

### MVP

1. **Permission broker (daemon)** — accept a forwarded request, fan it out to the
   UI, accept a verdict, hand the verdict to the channel, and broadcast a
   `resolved` event.
   - Acceptance: `POST /api/permission-request` fans a `request` event to a parked
     `GET /api/permission-stream`; `POST /api/permission-verdict` wakes a parked
     `GET /api/permission-pull` with `{request_id, behavior}` and emits a
     `resolved` event; cold-start stash works; all endpoints token-gated.
2. **Channel relay** — declare the capability, forward inbound requests, return
   the verdict to the session.
   - Acceptance: with `claude/channel/permission` declared, a `permission_request`
     notification is POSTed to the daemon; the resolved verdict is sent back as a
     `notifications/claude/channel/permission` with the verbatim `request_id` and
     `behavior`; the running session's tool call proceeds/denies accordingly.
3. **Permission modal (UI)** — render the request and capture the verdict.
   - Acceptance: a `request` event opens a modal showing `tool_name`,
     `description`, `input_preview`; Allow/Deny POSTs the verdict; the modal
     auto-closes on own-verdict, on a `resolved` event, or on a TTL fallback.
4. **Attention** — pull the user back when a request arrives.
   - Acceptance: on a new request, a browser notification fires (after a one-time
     permission ask; degrades silently if denied) and the tab title flashes /
     shows a badge while pending and the tab is hidden; both clear on close.

### Later

- **Reuse the modal for `needs_your_call`** — deferred; build reusable, migrate later.
- **Instant resolved-elsewhere close** — if the empirical spike (Open question 1)
  finds a cancel notification, wire it for an instant close instead of TTL.

## Tech decisions

- **Stack**: Bun + TypeScript (no transpile), petite-vue frontend, **no build step**
  (`dashboard/dist/` committed, vendor libs included). MCP via `@modelcontextprotocol/sdk`.
- **Storage**: none new — pending requests/verdicts live in-memory in the daemon
  (in `sessionId`-keyed `Map`s with TTL stashes), exactly like `broker.ts`/`inbox.ts`.
- **Deployment**: local only; all endpoints bind `127.0.0.1` and are token-gated
  with the daemon secret from `~/.cockpit/daemon.json`.
- **Conventions**: see `tasks/_context/shared.md`. Protocol contract: see
  `tasks/_context/protocol.md`.

## Architecture

```
running Claude session
  │  notifications/claude/channel/permission_request {request_id, tool_name, description, input_preview}
  ▼
cockpit-channel.ts (NEW: setNotificationHandler)
  │  POST /api/permission-request
  ▼
daemon (permission.ts)  ──SSE /api/permission-stream──▶  UI modal (+ notification + title flash)
  ▲                                                          │
  │  GET /api/permission-pull (long-poll)        POST /api/permission-verdict {request_id, behavior}
  │  ◀── verdict ──┐                                         │
cockpit-channel.ts ─┘◀───────────── daemon ◀────────────────┘
  │  notifications/claude/channel/permission {request_id, behavior}
  ▼
running Claude session (tool proceeds / denies)

resolved event (auto-close): emitted by the daemon when a verdict is delivered,
or when the channel forwards a cancel notification (POST /api/permission-resolved)
IF one exists; the UI also TTL-dismisses as a guaranteed fallback.
```

- `permission.ts` mirrors `broker.ts` + `inbox.ts`: `sessionId`-keyed `Map`s, a
  long-poll budget under the daemon's 255s `idleTimeout`, TTL stashes for races,
  `daemonToken()` auth. New code lives beside them in
  `packages/monitor/skills/cockpit/scripts/`.
- The channel grows a `permission_request` notification handler and a verdict
  pull loop; its existing inbox loop is untouched and runs independently.
- The UI grows one reusable modal module under `dashboard/dist/modules/` plus the
  attention helpers; it subscribes to a new SSE stream.

## Bucketing

- **Strategy**: layer (backend / channel / ui).
- **Why**: the daemon endpoints are the contract both the channel and the UI
  depend on, so `backend/01` is the single root that unblocks the other two
  buckets to proceed in parallel.

### Buckets

- **`backend/`** — daemon-side permission broker module + route wiring. Starts
  first; `backend/01` is the root.
- **`channel/`** — the `cockpit-channel.ts` capability, notification handler, and
  verdict round-trip. Needs the daemon contract.
- **`ui/`** — the permission modal (with auto-close lifecycle) and the attention
  mechanism. Needs the daemon contract; attention layers on the modal.

## Task index

| Bucket | NN | Title | Status | Depends on |
|---|---|---|---|---|
| backend | 01 | permission-broker | todo | — |
| backend | 02 | wire-routes | todo | backend/01 |
| channel | 01 | permission-relay | todo | backend/01 |
| ui | 01 | permission-modal | todo | backend/01 |
| ui | 02 | attention | todo | ui/01 |

## Cross-bucket dependencies

```
backend/01 ─┬─▶ backend/02
            ├─▶ channel/01
            └─▶ ui/01 ─▶ ui/02
```

Root (no deps): `backend/01`. Once it lands, `backend/02`, `channel/01`, and
`ui/01` can all proceed in parallel.

## Open questions

1. **Does Claude Code notify the channel when a `permission_request` is resolved
   elsewhere?** The Channels reference says a terminal answer "drops the pending
   remote request" but is silent on whether the channel is told. No documented
   `permission_cancel` / `permission_resolved` method. Resolve empirically during
   `channel/01`; if one exists, wire it for an instant auto-close (the UI's TTL
   fallback covers the case where it doesn't).
2. **Does a `PreToolUse` auto-approve hook suppress the channel
   `permission_request`?** Hook-vs-channel ordering is undocumented. If the hook
   short-circuits the prompt, no modal ever appears (best case). If both fire, the
   auto-close lifecycle handles the stale modal. Confirm empirically during
   `channel/01`.

## Known gaps

- If no cancel notification exists (Open question 1), a request resolved in the
  terminal / by a hook leaves the channel's verdict long-poll waiting until its
  budget elapses — a minor in-flight fetch leak per orphaned request, not a
  correctness bug. The UI still closes via TTL.

## References

- Channels reference: https://code.claude.com/docs/en/channels-reference
- Plugin channels schema: https://code.claude.com/docs/en/plugins-reference
- Prior feature (the channel itself): `packages/monitor/skills/cockpit/scripts/cockpit-channel.ts`
- Reused patterns: `packages/monitor/skills/cockpit/scripts/broker.ts`, `.../inbox.ts`
