# Shared context

> All tasks reference this. Decisions here override anything inferred from the codebase.

## Project at a glance

The **monitor** plugin (in `cc-plugins`, a Claude Code + Codex marketplace)
bundles two skills: **cockpit** (per-session windshield — decision trail + live
transcript + wait/send bridge, daemon on port 5858) and **usage-dashboard**
(rear-view usage analytics, server on port 5938). This work adds a **channel**:
a way to talk to a running Claude Code session from the cockpit UI. Single user
(Q), local-only.

## Tech stack

- **Runtime**: Bun (TypeScript, no transpile step). Uses `bun:sqlite`, `Bun.serve`, `Bun.file`.
- **Frontend**: petite-vue (not full Vue) + Chart.js. **No build step** — `dashboard/dist/` is committed as-is, vendor libs included under `dashboard/dist/vendor/`.
- **MCP**: `@modelcontextprotocol/sdk` (for the channel server only; it's the one new dependency, used by `cockpit-channel.ts`).
- **Storage**: none new. The Claude session transcript is the record; inbox/reply state is in-memory + ephemeral SSE. Daemon coords live in `~/.cockpit/daemon.json`.

## Code style

- Prefer `type` over `interface`.
- No external npm deps in the dashboard — vendor libs are committed.
- Comments in English. Keep changes surgical: touch only what the task needs; don't refactor adjacent code; match existing style.
- Pricing/unrelated conventions don't apply here.
- Authoritative source (verification only): repo root `CLAUDE.md` and `packages/monitor/CLAUDE.md`.

## File / directory layout

- Daemon-side scripts: `packages/monitor/skills/cockpit/scripts/*.ts`. New endpoint handlers are their own module (e.g. `inbox.ts`) and get wired into the `fetch` router in `cockpit-server.ts`. Tests sit beside as `*.test.ts`, run by `bun test`.
- Channel server: new `packages/monitor/skills/cockpit/scripts/cockpit-channel.ts`.
- Frontend: `packages/monitor/skills/cockpit/dashboard/dist/` — `app.js`, `style.css`, `modules/*.js`. Edit the committed files directly (no bundler).
- usage-dashboard server: `packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts`.

## Existing patterns to reuse (do not reinvent)

- **`broker.ts`** — the per-session control loop (`/api/wait` long-poll + `/api/respond`). `inbox.ts` mirrors it: a `Map<sessionId, resolver>`, a re-pollable timeout sentinel kept under the 255s `idleTimeout`, cold-start stash with TTL, and `daemonToken()` auth read fresh from `~/.cockpit/daemon.json`.
- **`daemon-lifecycle.ts`** — `decideStartup(info, myRoot, isAlive)` → `reuse | supersede | start`, with `DaemonInfo = { pid, port, token, root }` in `~/.cockpit/daemon.json`. Reuse this exact pattern for the atlas singleton.
- **`http.ts`** — `jsonResponse(obj)` / `jsonError(err, status?)` helpers for handlers.
- **`transcript-stream.ts`** + `dashboard/dist/modules/transcript.js` — the live transcript view. Both directions of channel chat already flow through here (transcript is the record).
- **`registry.ts`** — `sessionsPayload()` / `RegistryEntry`; sessions register in `~/.cockpit/registry.json` with their provider.

## Verification baseline

- Test: `bun test packages/monitor/skills/cockpit/scripts/`
- Run cockpit daemon: `bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts [--port N] [--no-open]`
- Run usage-dashboard: `bun packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts [--port N] [--no-open]`
- Dev server is run by Q, not by sub-agents — do not start long-lived servers in a task; write code + tests and let Q run them.
- Channels need launch flag: `claude --dangerously-load-development-channels server:cockpit-channel` (requires Claude Code ≥ 2.1.80).

## Decisions frozen during interview

- **Channel server is a daemon client** — no own HTTP port; avoids port-per-session collisions.
- **Auto-start scope** — the channel brings up **both** cockpit and usage-dashboard.
- **Registration** — user-level `~/.claude.json` `mcpServers` (works in every project); `plugin.json` has no `mcpServers` field.
- **v1 is two-way** — UI→agent inbox + agent→UI reply tool.
- **No separate chat persistence** — the Claude session transcript is the single source of truth; `/api/reply` fan-out is ephemeral display only.
- **Reply tool: yes** — so the agent addresses cockpit explicitly (Q otherwise has to switch to the terminal).
- **No gating spike** — the risky assumptions are early acceptance checks in `launch/02`.
- **Codex** — observe-only; UI send box disabled for it.

## Commit & branching style

- Branch: work happens on `develop` (the default branch).
- Commit format: emoji + conventional (e.g. `✨ feat:`, `🐛 fix:`). Use `/odin-git:simple-commit` for a single change or `/odin-git:atomic-commit` for several — **confirm with Q first** (AskUserQuestion).
- Release (only when cutting one): bump the **three** version fields together — `.claude-plugin/marketplace.json`, `packages/monitor/.claude-plugin/plugin.json`, `packages/monitor/.codex-plugin/plugin.json` — plus a `CHANGELOG.md` entry. Not part of these tasks unless asked.
