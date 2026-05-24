# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin marketplace (`q-lab-marketplace`) containing local plugins. Currently ships one plugin: **token-atlas** — a local web dashboard that visualizes Claude Code and Codex usage (sessions, tokens, cost, model mix, project activity).

## Architecture

```
cc-plugins/
├── .claude-plugin/marketplace.json   # marketplace registry (lists plugins)
├── CHANGELOG.md                      # release notes (Keep a Changelog format)
└── token-atlas/                      # plugin: usage dashboard
    ├── .claude-plugin/plugin.json    # plugin manifest
    └── skills/dashboard/             # the skill that powers /token-atlas
        ├── SKILL.md                  # skill trigger config & docs
        ├── PRODUCT.md                # design direction — Sunrise Atlas (Big Sur dawn palette, calm working surface, anti-Nordic)
        ├── scripts/
        │   ├── api.ts               # data engine — reads ~/.claude/ & ~/.codex/, merges pricing, exports buildStats()
        │   ├── live.ts              # live-sessions engine (Claude + Codex) — active sessions for the "Live now" panel
        │   ├── atlas-server.ts      # Bun HTTP server (static + /api/stats + /api/live)
        │   └── install.ts           # prerequisite checker
        ├── dashboard/dist/          # static SPA (petite-vue + Chart.js, no build step)
        └── references/
            └── pricing-defaults.json
```

### Data Flow

1. `api.ts` reads local files: `~/.claude/stats-cache.json`, `~/.claude/history.jsonl`, `~/.claude/projects/**/*.jsonl`, `~/.codex/state_5.sqlite`, `~/.codex/sessions/`
2. Pricing: defaults → OpenRouter live fetch (3s timeout, silent fail) → user override at `~/.config/cc-dashboard/pricing.json`
3. `atlas-server.ts` exposes `GET /api/stats` (calls `buildStats()`) and serves `dashboard/dist/` statically
4. Frontend fetches `/api/stats` on load, renders with petite-vue + Chart.js

### Live sessions ("Live now" panel)

Purely additive — the `/api/stats` snapshot is untouched. `live.ts` powers one endpoint (server binds `127.0.0.1`):

1. `GET /api/live` — active sessions from both providers: Claude from `~/.claude/sessions/*.json` (status `busy`/`idle`/`waiting`, stale-filtered at 10 min) and Codex from the `threads` table in `~/.codex/state_5.sqlite` (status `active-inferred`/`recent`). Drives the "Live now" panel, polled every 3s (paused while the tab is hidden).

token-atlas does **not** render transcripts — it's the rear-view (usage analytics). Clicking a Live-now row calls `openInCockpit(session)`, which opens `http://localhost:5858/?session=<id>&provider=<p>&project=<cwd>` in a new tab: cockpit (the live windshield) owns the transcript view. The transcript renderer + `marked`/`DOMPurify`/`highlight.js` vendors were removed here to avoid maintaining two copies — cockpit's `transcript-stream.ts` + `modules/transcript.js` are the single source.

### Key Design Decisions

- **No build step** for frontend — `dashboard/dist/` is committed as-is, vendor libs included
- **Bun-only** runtime — uses `bun:sqlite`, `Bun.serve`, `Bun.file`
- Model usage keys are namespaced as `provider:model` (e.g. `claude:claude-opus-4-7`, `codex:o3`)
- **Billing dedup** — `api.ts` dedups transcript entries by `requestId:messageId` to avoid double-counting usage.
- **Theme** — light + dark via `[data-theme]` on `<html>`; tokens defined twice in `style.css`; toggle uses the View Transitions API for a cross-fade
- **Sunrise Bloom delight** — `.panel` / `.card` / `.budget-panel` / `.data-health-panel` use an `::before` (or `::after`) radial-gradient bloom. JS `installBloomTracker()` in `app.js` lerps `--bloom-x/--bloom-y` toward cursor each frame for the trailing effect. Add new panel-shaped classes to **both** the CSS selector list and the JS `SELECTOR` constant
- **Hero wave** — `.hero-band` uses a 200%-wide SVG `mask-image` containing two identical wave cycles; `hero-wave-drift` animation slides `mask-position-x` one wavelength for a seamless loop
- **Live-now panel** — the `.live-panel` is registered in both the bloom CSS list and the JS `SELECTOR`. Rows link out to cockpit (`openInCockpit`); token-atlas itself renders no transcript.

## Commands

```bash
# Run the dashboard (port 5938, auto-opens browser)
bun token-atlas/skills/dashboard/scripts/atlas-server.ts

# Run with custom port / no auto-open
bun token-atlas/skills/dashboard/scripts/atlas-server.ts --port 9000 --no-open

# Run install checks (verifies bun, data sources, vendor files)
bun token-atlas/skills/dashboard/scripts/install.ts

# Get stats as JSON (CLI mode of api.ts)
bun token-atlas/skills/dashboard/scripts/api.ts

# Get active live sessions as JSON (CLI mode of live.ts)
bun token-atlas/skills/dashboard/scripts/live.ts

# Inspect the live-sessions endpoint against a running server
curl -s localhost:5938/api/live | jq
```

## Code Conventions

- Runtime: Bun (TypeScript, no transpile step needed)
- Use `type` over `interface`
- Frontend: petite-vue (not full Vue), Chart.js for charts
- No external npm dependencies — vendor libs (petite-vue, Chart.js, marked, DOMPurify, highlight.js) are committed in `dashboard/dist/vendor/`
- Pricing is per-1M-tokens USD

## Releasing

⚠️ **Two version files must be bumped together** — they drift easily, and the marketplace shows the wrong version if they disagree:

- `.claude-plugin/marketplace.json` → `plugins[].version`
- `token-atlas/.claude-plugin/plugin.json` → `version`

`/odin-git:release` only auto-detects `marketplace.json`, so **manually bump `plugin.json` to match** before finishing any release, then add the matching `CHANGELOG.md` entry.
