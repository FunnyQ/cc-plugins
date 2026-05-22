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
        │   ├── live.ts              # LIVE engine (Claude + Codex) — active sessions + SSE transcript stream + history paging
        │   ├── serve-dashboard.ts   # Bun HTTP server (static + /api/stats + /api/live + /api/stream + /api/transcript)
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

### LIVE Data Flow (Claude + Codex)

Purely additive — the `/api/stats` snapshot is untouched. `live.ts` powers three endpoints (server binds `127.0.0.1`):

1. `GET /api/live` — active sessions from both providers: Claude from `~/.claude/sessions/*.json` (status `busy`/`idle`/`waiting`, stale-filtered at 10 min) and Codex from the `threads` table in `~/.codex/state_5.sqlite` (status `active-inferred`/`recent`). Drives the "Live now" panel, polled every 3s (paused while the tab is hidden).
2. `GET /api/stream?provider=<claude|codex>&id=<uuid>` — SSE tail of the session transcript (Claude: `~/.claude/projects/**/<id>.jsonl`; Codex: the thread row's `rollout_path` under `~/.codex/sessions/`): sends a backlog (last ~50 lines, read backward in chunks, decoded once for UTF-8 safety) then `fs.watch`-tails new appends. Powers the click-to-open transcript modal. (Legacy `?session=` is still accepted.)
3. `GET /api/transcript?provider=<…>&id=<uuid>&before=<byteOffset>&limit=<n>` — reverse-pagination: older entries before a byte-offset cursor, for scroll-to-top history loading. The SSE `backlog-done` frame carries the initial `historyStart` cursor.

Path security (stream + history): validate `^[0-9a-f-]{36}$` first, resolve the provider's path, then `realpath`-confine inside the provider root — `~/.claude/projects` (`isInsideProjects`) for Claude, `~/.codex/sessions` (`isInsideCodexSessions`) for Codex.

### Key Design Decisions

- **No build step** for frontend — `dashboard/dist/` is committed as-is, vendor libs included
- **Bun-only** runtime — uses `bun:sqlite`, `Bun.serve`, `Bun.file`
- Model usage keys are namespaced as `provider:model` (e.g. `claude:claude-opus-4-7`, `codex:o3`)
- **Deduplication differs by purpose**: *billing* (`api.ts`) dedups transcript entries by `requestId:messageId` to avoid double-counting usage. *LIVE display* (`live.ts` / frontend) dedups by **`uuid`** instead — one assistant response persists its `thinking` / `text` / `tool_use` as separate lines that *share* `requestId:messageId`, so keying on that would drop the actual reply; `uuid` is per-line, so it only catches true reconnect resends.
- **Theme** — light + dark via `[data-theme]` on `<html>`; tokens defined twice in `style.css`; toggle uses the View Transitions API for a cross-fade
- **Sunrise Bloom delight** — `.panel` / `.card` / `.budget-panel` / `.data-health-panel` use an `::before` (or `::after`) radial-gradient bloom. JS `installBloomTracker()` in `app.js` lerps `--bloom-x/--bloom-y` toward cursor each frame for the trailing effect. Add new panel-shaped classes to **both** the CSS selector list and the JS `SELECTOR` constant
- **Hero wave** — `.hero-band` uses a 200%-wide SVG `mask-image` containing two identical wave cycles; `hero-wave-drift` animation slides `mask-position-x` one wavelength for a seamless loop
- **LIVE rendering** — each transcript entry is pre-rendered to HTML once on receipt (`entry.__html`, keyed by `entry.__key`) to avoid re-running Markdown on every reactive update. Content is split into segments: prose → Markdown (rendered with `marked`, sanitized with DOMPurify; GFM tables + new-tab safe links), `thinking` → "💭 thinking" badge (muted), `tool_use` / `tool_result` / JSON dumps → escaped `<pre>` code blocks, syntax-highlighted with highlight.js — markdown fences by language/auto-detect, tool blocks only when confirmed JSON, and `Read` results render as a line-number gutter beside a block highlighted by the file's extension (>10 lines collapse into `<details>`). File edits (`Edit`/`MultiEdit`/`Write`, Codex `apply_patch`) render as inline color-coded diffs. Tool calls and their results are paired by `tool_use_id` (`reconcileToolResults()`): a `tool_result`-only entry is merged into the entry holding its `tool_use` and the standalone "user" bubble is dropped. Only conversation types stream (`DISPLAY_ENTRY_TYPES` allowlist) — session-metadata noise (`file-history-snapshot`, `queue-operation`, `last-prompt`, …) is filtered at the source.
- **LIVE scroll** — auto-scroll only when bottom-pinned (`streamPinnedToBottom`); reverse-pagination triggers on scroll-to-top from any input, anchored on the topmost entry's `offsetTop` (immune to live appends), and the `streamLoadingOlder` flag is cleared in a `requestAnimationFrame` so the anchor-restore scroll isn't mistaken for a fresh user scroll. The `.live-panel` is registered in both the bloom CSS list and the JS `SELECTOR`.

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

# Get active live sessions as JSON (CLI mode of live.ts)
bun token-atlas/skills/dashboard/scripts/live.ts

# Inspect LIVE endpoints against a running server
curl -s localhost:5938/api/live | jq
curl -N "localhost:5938/api/stream?session=<uuid>"
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
