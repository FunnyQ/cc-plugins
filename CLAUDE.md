# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code (and Codex) plugin marketplace (`q-lab-marketplace`) containing one local plugin, **monitor**, which bundles three sibling skills:

- **usage-dashboard** — the rear-view mirror: a local web dashboard that visualizes Claude Code and Codex usage (sessions, tokens, cost, model mix, project activity).
- **cockpit** — the windshield: a per-project session cockpit (goal capture, distilled decision log, live transcript, a `needs_your_call` wait/send bridge, and a send box for running sessions). Its dashboard daemon owns the live transcript view that usage-dashboard's "Live now" rows link into. Claude Code sends use the cockpit channel MCP server; Codex sends use the managed Codex remote-control app-server socket, with direct app-server as fallback. The channel is UI→agent only: the agent's answers ride the transcript (the single source of truth — no separate reply tool).
- **install** — one-stop setup (command-triggered): the canonical home for all prerequisite checks and config wiring for the whole plugin. `setup.ts` checks both skills and wires the one config a non-dev user can't easily edit by hand — the statusline collector in `~/.claude/settings.json`. (The **cockpit channel** is now packaged in the plugin manifest — `mcpServers` + `channels` in `.claude-plugin/plugin.json` — so it no longer needs a hand-written `~/.claude.json` entry; setup.ts only *cleans up* a stale entry left by older versions, which would otherwise double-register the channel.) The dashboard precheck (`install.ts`) and statusline wiring (`setup-statusline.ts` + pure `statusline-decision.ts`) live here; usage-dashboard imports them rather than owning copies. A **`SessionStart` hook** (in `.claude-plugin/plugin.json`) runs `setup.ts --session-check` — marker-gated via `$CLAUDE_PLUGIN_DATA/.wired-version`, so once per version it silently re-points a version-drifted statusline path (the cache encodes the version, e.g. `.../monitor/3.1.0/...`, and old dirs linger so "wired" means *exact current path*, not mere existence) and removes any stale channel entry, or, on a fresh install, prints one write-free nudge to run `/monitor:install`. It never fresh-wires the statusline — initial opt-in stays manual.

This file documents usage-dashboard in depth; cockpit carries its own `SKILL.md`, `PRODUCT.md`, and `DESIGN.md` under `packages/monitor/skills/cockpit/`. The dashboard and cockpit run **independent** web servers (separate ports, separate `dist/` SPAs) — only the plugin packaging is merged.

## Architecture

```
cc-plugins/
├── .claude-plugin/marketplace.json   # Claude marketplace registry (one plugin: monitor)
├── .agents/plugins/marketplace.json  # Codex marketplace registry (one plugin: monitor)
├── CHANGELOG.md                      # release notes (Keep a Changelog format)
└── packages/monitor/                 # the only plugin (monorepo layout: packages/<plugin>)
    ├── .claude-plugin/plugin.json    # Claude manifest (version must match marketplace.json) + SessionStart hook → setup.ts --session-check
    ├── .codex-plugin/plugin.json     # Codex manifest (skills: "./skills/" — both auto-discovered; no hooks support)
    └── skills/
        ├── usage-dashboard/          # skill: usage dashboard (the rear-view)
        │   ├── SKILL.md              # skill trigger config & docs
        │   ├── PRODUCT.md            # design direction — Sunrise Atlas (Big Sur dawn palette, calm working surface, anti-Nordic)
        │   ├── scripts/
        │   │   ├── api.ts            # data engine — reads ~/.claude/ & ~/.codex/, merges pricing, exports buildStats()
        │   │   ├── live.ts           # live-sessions engine (Claude + Codex) — active sessions for the "Live now" panel
        │   │   ├── atlas-server.ts   # Bun HTTP server (static + /api/stats + /api/live), port 5938
        │   │   └── statusline-collector.ts # captures live rate_limits, chains ccstatusline
        │   ├── dashboard/dist/       # static SPA (petite-vue + Chart.js, no build step)
        │   └── references/
        │       └── pricing-defaults.json
        ├── cockpit/                  # skill: per-project session cockpit (own SKILL/PRODUCT/DESIGN/references)
        │   ├── scripts/cockpit-server.ts # Bun daemon (singleton via ~/.cockpit/daemon.json), port 5858: decision-log SSE + transcript stream + wait/send broker + Claude inbox/send + Codex remote-control send
        │   ├── scripts/cockpit.ts        # CLI: start / log / wait / send
        │   ├── scripts/cockpit-channel.ts # channel MCP server (stdio): long-polls /api/inbox, injects UI text into the live session (no tools — agent→UI is the transcript)
        │   ├── scripts/codex-control-probe.ts # Codex app-server control client: managed remote-control websocket first, direct app-server fallback
        │   └── dashboard/dist/           # static SPA (petite-vue), Night Flight design system
        └── install/                  # skill: one-stop setup/precheck for the whole plugin (command-triggered)
            └── scripts/
                ├── setup.ts          # monitor:install engine — checks both skills + wires the statusline config (--check/--dry-run/--apply); --migrate re-points statusline drift + removes the stale channel entry; --session-check is the marker-gated hook entry
                ├── install.ts        # canonical dashboard precheck (exports dashboardChecks/printReport; CLI too)
                ├── setup-statusline.ts   # statusline wiring (exports applyStatusline; CLI too)
                └── statusline-decision.ts # pure wrap/stale/skip decision (unit-tested)
```

### Data Flow

1. `api.ts` reads local files: `~/.claude/stats-cache.json`, `~/.claude/history.jsonl`, `~/.claude/projects/**/*.jsonl`, `~/.codex/state_5.sqlite`, `~/.codex/sessions/`
2. Pricing: defaults → OpenRouter live fetch (3s timeout, silent fail) → user override at `~/.config/cc-dashboard/pricing.json`
3. `atlas-server.ts` exposes `GET /api/stats` (calls `buildStats()`) and serves `dashboard/dist/` statically
4. Frontend fetches `/api/stats` on load, renders with petite-vue + Chart.js

### Live sessions ("Live now" panel)

Purely additive — the `/api/stats` snapshot is untouched. `live.ts` powers one endpoint (server binds `127.0.0.1`):

1. `GET /api/live` — active sessions from both providers: Claude from `~/.claude/sessions/*.json` (status `busy`/`idle`/`waiting`, stale-filtered at 10 min) and Codex from the `threads` table in `~/.codex/state_5.sqlite` (status `active-inferred`/`recent`). Drives the "Live now" panel, polled every 3s (paused while the tab is hidden).

usage-dashboard does **not** render transcripts — it's the rear-view (usage analytics). Clicking a Live-now row calls `openInCockpit(session)`, which opens `http://localhost:<cockpitPort>/?session=<id>&provider=<p>&project=<cwd>` in a new tab: cockpit (the live windshield) owns the transcript view. The port comes from `/api/live`'s `cockpitPort` (read from cockpit's `~/.cockpit/daemon.json`, so a custom-`--port` cockpit still resolves), falling back to `5858`; rows are inert when `cockpitUp` is false so a dead daemon never opens a broken tab. The transcript renderer + `marked`/`DOMPurify`/`highlight.js` vendors were removed here to avoid maintaining two copies — cockpit's `transcript-stream.ts` + `modules/transcript.js` are the single source.

### Key Design Decisions

- **No build step** for frontend — `dashboard/dist/` is committed as-is, vendor libs included
- **Bun-only** runtime — uses `bun:sqlite`, `Bun.serve`, `Bun.file`
- Model usage keys are namespaced as `provider:model` (e.g. `claude:claude-opus-4-7`, `codex:o3`)
- **Billing dedup** — `api.ts` dedups transcript entries by `requestId:messageId` to avoid double-counting usage.
- **Theme** — light + dark via `[data-theme]` on `<html>`; tokens defined twice in `style.css`; toggle uses the View Transitions API for a cross-fade
- **Sunrise Bloom delight** — `.panel` / `.card` / `.budget-panel` / `.data-health-panel` use an `::before` (or `::after`) radial-gradient bloom. JS `installBloomTracker()` in `app.js` lerps `--bloom-x/--bloom-y` toward cursor each frame for the trailing effect. Add new panel-shaped classes to **both** the CSS selector list and the JS `SELECTOR` constant
- **Hero wave** — `.hero-band` uses a 200%-wide SVG `mask-image` containing two identical wave cycles; `hero-wave-drift` animation slides `mask-position-x` one wavelength for a seamless loop
- **Live-now panel** — the `.live-panel` is registered in both the bloom CSS list and the JS `SELECTOR`. Rows link out to cockpit (`openInCockpit`); usage-dashboard itself renders no transcript.

## Commands

```bash
# Run the dashboard (port 5938, auto-opens browser)
bun packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts

# Run with custom port / no auto-open
bun packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts --port 9000 --no-open

# Run the full monitor:install engine — checks both skills + wires configs
bun packages/monitor/skills/install/scripts/setup.ts            # --check (default)
bun packages/monitor/skills/install/scripts/setup.ts --dry-run  # preview writes
bun packages/monitor/skills/install/scripts/setup.ts --apply    # wire both pieces

# Run only the dashboard precheck (verifies bun, data sources, vendor files)
bun packages/monitor/skills/install/scripts/install.ts

# Get stats as JSON (CLI mode of api.ts)
bun packages/monitor/skills/usage-dashboard/scripts/api.ts

# Get active live sessions as JSON (CLI mode of live.ts)
bun packages/monitor/skills/usage-dashboard/scripts/live.ts

# Inspect the live-sessions endpoint against a running server
curl -s localhost:5938/api/live | jq

# Run the cockpit daemon (port 5858)
bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts

# Dev: a live channel-flagged Claude session keeps respawning the cached daemon
# (the channel MCP's reconnect loop calls ensureCockpitDaemon when the daemon
# dies), so a repo-root daemon loses the supersede war for port 5858. To test
# working-tree changes against an isolated daemon, run it on its own port + home:
COCKPIT_HOME=/tmp/cockpit-dev bun packages/monitor/skills/cockpit/scripts/cockpit-server.ts --port 5999

# Run the cockpit test suite
bun test packages/monitor/skills/cockpit/scripts/

# Run the install skill test suite
bun test packages/monitor/skills/install/scripts/
```

## Code Conventions

- Runtime: Bun (TypeScript, no transpile step needed)
- Use `type` over `interface`
- Frontend: petite-vue (not full Vue), Chart.js for charts
- No external npm dependencies — vendor libs (petite-vue, Chart.js, marked, DOMPurify, highlight.js) are committed in `dashboard/dist/vendor/`
- Pricing is per-1M-tokens USD

## Releasing

⚠️ **Three version fields must be bumped together** — they drift easily, and the marketplace shows the wrong version if they disagree:

- `.claude-plugin/marketplace.json` → `plugins[].version` (the single `monitor` entry)
- `packages/monitor/.claude-plugin/plugin.json` → `version`
- `packages/monitor/.codex-plugin/plugin.json` → `version`

`/odin-git:release` only auto-detects `marketplace.json`, so **manually bump both `plugin.json` files to match** before finishing any release, then add the matching `CHANGELOG.md` entry.
