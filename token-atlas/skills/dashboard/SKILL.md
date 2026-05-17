---
name: dashboard
description: >-
  Launch a local web dashboard that visualizes Claude Code and Codex usage from
  ~/.claude/ and ~/.codex/. Shows overview cards (sessions, interactions,
  tokens, cost), daily token trend chart, model distribution donut, activity
  heatmap, top projects, and recent activity. Trigger phrases include:
  "/token-atlas", "/cc-dashboard", "/stats-dashboard", "show my claude stats",
  "claude usage dashboard", "open token atlas", "open stats dashboard",
  "查看 claude 用量", "claude code 統計", "顯示我的 claude 使用情形",
  "token atlas". AUTO-TRIGGER when the user wants a visual breakdown of their
  Claude Code usage, costs, or project activity beyond the built-in /stats
  text output.
---

# AI Code Stats Dashboard

A petite-vue + Chart.js single-page dashboard served from a local Bun HTTP server. Reads `~/.claude/stats-cache.json`, `~/.claude/history.jsonl`, `~/.claude/projects/`, `~/.codex/state_5.sqlite`, and `~/.codex/sessions/` — no telemetry, no network access required (OpenRouter is consulted opportunistically for live pricing but failures are silent).

## Run

Always run the precheck first; only launch the dashboard if it exits 0.

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/dashboard/scripts/install.ts \
  && bun ${CLAUDE_PLUGIN_ROOT}/skills/dashboard/scripts/serve-dashboard.ts
```

The precheck (`install.ts`) verifies `bun`, vendor files, and Claude data sources. It distinguishes **required** failures (`✗`, exit 1) from **optional** ones (`○`, exit 0 with a notice). Optional gaps — typically `history.jsonl` missing because the user hasn't used Claude Code chat yet — do **not** block the dashboard; the affected sections will just show empty.

If the precheck exits non-zero, surface the failed `✗` lines and their `→ hint` to the user verbatim and stop. Do **not** attempt to auto-fix (no `bun install`, no file fetches) — the hints are actionable steps the user takes themselves (e.g. installing bun, running `/stats` once in Claude Code to seed `stats-cache.json`).

Default port `5938`. Opens `http://localhost:5938` in the default browser automatically. If the port is already in use (e.g. a previous dashboard instance), the script kills the existing process first so you don't accumulate stale servers.

Flags:
- `--port <n>` — pick a different port
- `--no-open` — skip auto-open (just print URL)

## Sections

- **Provider switch** — All / Claude / Codex, with All as the combined default
- **Overview cards** — sessions, interactions, tokens, estimated cost from local usage (filtered by date range)
- **Daily trend** — line chart per provider model with Tokens/Cost switch and multi-select toggle
- **Model distribution** — donut chart filtered by date range and provider
- **Per-model cost & tokens table** — provider, input/output/cache/reasoning breakdown with USD estimate, filtered by date range
- **Activity heatmap** — 7d × 24h grid plus GitHub-style daily activity wall built from local activity data
- **Top projects** — ranked by message count with % bar
- **Recent activity** — projects sorted by last seen

## Pricing

Defaults shipped in `references/pricing-defaults.json`. On startup the server tries OpenRouter `/api/v1/models` (3s timeout) and merges live prices. User overrides win — drop a JSON file at `~/.config/cc-dashboard/pricing.json`:

```json
{
  "models": {
    "claude-opus-4-7": { "input": 5.00, "output": 25.00, "cacheRead": 0.50, "cacheWrite": 6.25 }
  }
}
```

External (non-Anthropic) models without dedicated cache pricing have cache tokens counted as input.

## Troubleshooting

- **Empty dashboard / "Missing or unreadable: stats-cache.json"** — open Claude Code and run `/stats` once to seed the cache.
- **Port in use** — script auto-kills whatever holds the port; if you'd rather use another, pass `--port 9000` (or any free port).
- **No projects shown** — `history.jsonl` may be missing or you've used Claude Code for less than a few sessions.
- **All costs look identical / wrong** — drop a custom pricing override at `~/.config/cc-dashboard/pricing.json`.

## File layout

```
dashboard/
├── SKILL.md
├── scripts/
│   ├── install.ts            # diagnostic
│   ├── api.ts                # data engine (also CLI: prints JSON)
│   └── serve-dashboard.ts    # HTTP server + auto-open
├── dashboard/dist/           # static frontend (no build step)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── vendor/
│       ├── petite-vue.es.js
│       └── chart.umd.js
└── references/
    └── pricing-defaults.json
```
