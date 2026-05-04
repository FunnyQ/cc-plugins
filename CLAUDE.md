# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin marketplace (`q-lab-marketplace`) containing local plugins. Currently ships one plugin: **token-atlas** — a local web dashboard that visualizes Claude Code and Codex usage (sessions, tokens, cost, model mix, project activity).

## Architecture

```
cc-plugins/
├── .claude-plugin/marketplace.json   # marketplace registry (lists plugins)
└── token-atlas/                      # plugin: usage dashboard
    ├── .claude-plugin/plugin.json    # plugin manifest
    └── skills/dashboard/             # the skill that powers /token-atlas
        ├── SKILL.md                  # skill trigger config & docs
        ├── PRODUCT.md                # design direction (Nordic-inflected, data-dense)
        ├── scripts/
        │   ├── api.ts               # data engine — reads ~/.claude/ & ~/.codex/, merges pricing, exports buildStats()
        │   ├── serve-dashboard.ts   # Bun HTTP server (serves static + /api/stats)
        │   └── install.ts           # prerequisite checker
        ├── dashboard/dist/          # static SPA (petite-vue + Chart.js, no build step)
        └── references/
            └── pricing-defaults.json
```

### Data Flow

1. `api.ts` reads local files: `~/.claude/stats-cache.json`, `~/.claude/history.jsonl`, `~/.claude/projects/**/*.jsonl`, `~/.codex/state_5.sqlite`, `~/.codex/sessions/`
2. Pricing: defaults → OpenRouter live fetch (3s timeout, silent fail) → user override at `~/.config/cc-dashboard/pricing.json`
3. `serve-dashboard.ts` exposes `GET /api/stats` (calls `buildStats()`) and serves `dashboard/dist/` statically
4. Frontend fetches `/api/stats` on load, renders with petite-vue + Chart.js

### Key Design Decisions

- **No build step** for frontend — `dashboard/dist/` is committed as-is, vendor libs included
- **Bun-only** runtime — uses `bun:sqlite`, `Bun.serve`, `Bun.file`
- Model usage keys are namespaced as `provider:model` (e.g. `claude:claude-opus-4-7`, `codex:o3`)
- Deduplication of billing: transcript entries are deduped by `requestId:messageId` to avoid double-counting

## Commands

```bash
# Run the dashboard (port 5938, auto-opens browser)
bun token-atlas/skills/dashboard/scripts/serve-dashboard.ts

# Run with custom port / no auto-open
bun token-atlas/skills/dashboard/scripts/serve-dashboard.ts --port 9000 --no-open

# Run install checks (verifies bun, data sources, vendor files)
bun token-atlas/skills/dashboard/scripts/install.ts

# Get stats as JSON (CLI mode of api.ts)
bun token-atlas/skills/dashboard/scripts/api.ts
```

## Code Conventions

- Runtime: Bun (TypeScript, no transpile step needed)
- Use `type` over `interface`
- Frontend: petite-vue (not full Vue), Chart.js for charts
- No external npm dependencies — vendor libs are committed in `dashboard/dist/vendor/`
- Pricing is per-1M-tokens USD
