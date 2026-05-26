# Cockpit Channel — talk to a running session from the UI

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-05-26

## Overview

Make the cockpit dashboard two-way: type a message in the UI and have it land in
a **running** Claude Code session in real time, and see the agent answer back —
without leaving cockpit. Built on Claude Code's official **Channels** (an MCP
server spawned by the session over stdio). Folded in: a **unified launch** where
that channel auto-starts the cockpit + usage-dashboard servers.

## Goals

- UI→agent: a cockpit send box delivers text into the live session (`<channel>` injection).
- agent→UI: a `reply` tool lets the agent address cockpit explicitly, shown in a dedicated strip.
- One launch flag brings up the channel **and** the cockpit + usage-dashboard daemons.
- Graceful when the daemon isn't up (the channel starts it) and when it dies mid-session (reconnect/respawn).

## Non-goals

- **Codex** — no channel/hook mechanism; observe-only. UI shows its send box disabled. Claude-only by nature.
- **Permission relay** (`claude/channel/permission`, approve Bash/Write from UI) — deferred to v2.
- **Retro-attach** to a session not launched with the channel — impossible; the channel spawns at session start.
- **Separate chat persistence** — rejected; the Claude session transcript is the single record.
- **Channel allowlist / `plugin.json` packaging** — stays on `--dangerously-load-development-channels` for now.

## Context

The cockpit dashboard is read-only today: you watch a decision trail + transcript;
the only reply path is the `needs_your_call` gate (solicited) or switching to the
terminal. Channels (research preview, requires Claude Code ≥ 2.1.80; local is
2.1.150) let an MCP server push events into the live turn loop and expose tools.
An earlier Stop-hook idea was rejected (one-way, stop-boundary-only, context-not-
instruction) — see `packages/monitor/skills/cockpit/CHANNEL-DESIGN.md`.

Key existing pieces this builds on: the singleton daemon + PID file
(`daemon-lifecycle.ts`, `~/.cockpit/daemon.json`), the per-session control-loop
broker (`broker.ts` — `/api/wait` + `/api/respond`), the transcript stream
(`transcript-stream.ts` + `dashboard/dist/modules/transcript.js`), and the
usage-dashboard server (`atlas-server.ts`, port 5938, currently no singleton).

## Requirements

### MVP

1. **Inbox broker** — daemon accepts UI messages and hands them to the channel.
   - Acceptance: `POST /api/send-message` wakes a parked `GET /api/inbox` long-poll for that session; cold-start stash works; token-gated.
2. **Reply fan-out** — agent replies reach the UI live.
   - Acceptance: `POST /api/reply` fans to subscribers of a reply SSE; ephemeral (no file).
3. **Channel server** — `cockpit-channel.ts` injects inbound and exposes `reply`.
   - Acceptance: UI text appears in the live session transcript; `reply` reaches the UI; **verified that `CLAUDE_CODE_SESSION_ID` reaches the child and `mcp.notification` lands in the transcript**.
4. **Auto-start + reconnect** — the channel brings up cockpit + usage-dashboard and survives a daemon restart.
   - Acceptance: launching with no daemon running brings both up; killing the daemon mid-session reconnects/respawns without wedging.
5. **Atlas singleton** — `atlas-server.ts` is idempotently startable.
   - Acceptance: starting it twice reuses the running instance instead of killing the port.
6. **UI send box + reply strip** — gated to Claude sessions with a live channel.
   - Acceptance: send box posts and clears; reply strip shows agent messages; Codex / no-channel sessions show it disabled.

### Later

- **Permission relay** — approve tool prompts from the UI. Deferred: needs the `claude/channel/permission` capability + verdict round-trip; not core to chat.
- **Allowlist packaging** — drop the dev flag once channels leave research preview.

## Tech decisions

- **Stack**: Bun + TypeScript (no transpile), petite-vue + Chart.js frontend, **no build step** (`dashboard/dist/` committed). MCP via `@modelcontextprotocol/sdk`.
- **Storage**: none new — transcript is the record; inbox/reply are in-memory + ephemeral SSE. Daemon coords in `~/.cockpit/daemon.json`.
- **Deployment**: local only, servers bind `127.0.0.1`, token-auth on new endpoints.
- **Conventions**: see `_context/shared.md`. Endpoint + protocol contract: see `_context/api-contract.md`.

## Architecture

```
cockpit UI ──POST /api/send-message──▶ daemon (singleton) ◀──GET /api/inbox (long-poll)── cockpit-channel.ts ── mcp.notification ──▶ running Claude session
   ▲                                       │                                                    ▲                                         │
   │                                       │                                          reads CLAUDE_CODE_SESSION_ID                        │
   └─ reply strip ◀─ SSE fan ◀─ POST /api/reply ◀───────────────── reply tool ◀── Claude calls reply ◀──────────────── agent answers ─────┘
                                                          (agent answer ALSO lands in transcript — cockpit already renders it)
```

- `cockpit-channel.ts` is a **client** of the singleton daemon (no own HTTP port → no port-per-session collisions). It long-polls `/api/inbox`, injects via `notifications/claude/channel`, and its `reply` tool POSTs `/api/reply`. On spawn it ensures cockpit + usage-dashboard are up; it reconnects/respawns if the daemon dies.
- `inbox.ts` mirrors `broker.ts`: a `Map` keyed by sessionId, long-poll budget under the 255s idleTimeout, cold-start stash with TTL, `daemonToken()` auth.

## Bucketing

- **Strategy**: layer (backend / launch / ui).
- **Why**: the daemon endpoints (backend) are the contract both the channel
  (launch) and the dashboard (ui) depend on, so backend roots unblock the rest;
  launch and ui can then proceed in parallel.

### Buckets

- **`backend/`** — daemon-side endpoints + the session `channel` flag. Starts first; `01`/`02` are roots.
- **`launch/`** — the channel MCP server, auto-start/reconnect, atlas singleton, registration + launcher.
- **`ui/`** — the send box and the reply strip in `dashboard/dist/`.

## Task index

| Bucket | NN | Title | Status | Depends on |
|---|---|---|---|---|
| backend | 01 | inbox-broker | done | — |
| backend | 02 | reply-fanout | done | — |
| backend | 03 | session-channel-flag | done | backend/01 |
| launch | 01 | atlas-singleton | done | — |
| launch | 02 | channel-server | in-progress | backend/01, backend/02 |
| launch | 03 | autostart-reconnect | in-progress | launch/01, launch/02 |
| launch | 04 | register-and-launcher | in-progress | launch/02 |
| ui | 01 | send-box | in-progress | backend/01, backend/03 |
| ui | 02 | reply-strip | in-progress | backend/02 |

## Cross-bucket dependencies

```
backend/01 ─┬─▶ backend/03 ─▶ ui/01
            ├─▶ launch/02 ─┬─▶ launch/03 ◀── launch/01
            │              └─▶ launch/04
backend/02 ─┴─▶ launch/02
backend/02 ───▶ ui/02
launch/01 (independent root) ─▶ launch/03
```

Roots (no deps, parallelizable): `backend/01`, `backend/02`, `launch/01`.

## Open questions

1. **Reply display vs transcript** — `ui/02` shows reply-tool messages in a
   dedicated strip via the reply SSE. If the transcript already renders them
   acceptably (verified in `launch/02`), the strip may be downgraded to a filter
   over the existing transcript stream. Resolve after `launch/02`.

## Known gaps

- See `tasks/README.md` "Known gaps" for the risk list (env-var reach, transcript
  serialization shape, research-preview volatility, daemon death mid-session).

## References

- `packages/monitor/skills/cockpit/CHANNEL-DESIGN.md` — the original design draft.
- Channels reference: https://code.claude.com/docs/en/channels-reference
- cockpit decision trail: `.cockpit/logs/<session>.jsonl` (the pivot from hooks → channels).
