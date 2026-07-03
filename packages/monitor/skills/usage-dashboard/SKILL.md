---
name: usage-dashboard
description: >-
  Launch a local web dashboard that visualizes Claude Code, Codex, and OpenCode
  usage from ~/.claude/, ~/.codex/, and ~/.local/share/opencode/. Shows
  overview cards (sessions, interactions, tokens, cost), daily token trend
  chart, model distribution donut, activity heatmap, top projects, and recent
  activity. Trigger phrases include:
  "/token-atlas", "/cc-dashboard", "/stats-dashboard", "show my claude stats",
  "claude usage dashboard", "open token atlas", "open stats dashboard",
  "查看 claude 用量", "claude code 統計", "顯示我的 claude 使用情形",
  "token atlas". AUTO-TRIGGER when the user wants a visual breakdown of their
  Claude Code usage, costs, or project activity beyond the built-in /stats
  text output.
---

# AI Code Stats Dashboard

A petite-vue + Chart.js single-page dashboard served from a local Bun HTTP server. Reads `~/.claude/stats-cache.json`, `~/.claude/history.jsonl`, `~/.claude/projects/`, `~/.codex/state_5.sqlite`, `~/.codex/sessions/`, and OpenCode data under `${OPENCODE_DATA_DIR:-~/.local/share/opencode}/opencode.db` with legacy JSON fallback from `storage/` plus `project/*/storage/`. By default it is local-only: no usage export is performed unless `LLM_QUOTA_INGEST_URL` is explicitly configured. OpenRouter is consulted opportunistically for live pricing, but failures are silent.

## Run

Always run the precheck first; only launch the dashboard if it exits 0.

```bash
bun <plugin-root>/skills/install/scripts/install.ts \
  && bun <plugin-root>/skills/usage-dashboard/scripts/atlas-server.ts
```

**`<plugin-root>`** resolves per runtime: under Claude Code use
`${CLAUDE_PLUGIN_ROOT}`; under Codex resolve it from the installed skill root that
contains this skill. In a development checkout of this repository,
`${CLAUDE_PLUGIN_ROOT}` is empty, so substitute `packages/monitor` from the repo
root — e.g. `bun packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts`.

The precheck (`install.ts`, owned by the sibling `install` skill) verifies `bun`, vendor files, and Claude data sources. It distinguishes **required** failures (`✗`, exit 1) from **optional** ones (`○`, exit 0 with a notice). Optional gaps — typically `history.jsonl` missing because the user hasn't used Claude Code chat yet — do **not** block the dashboard; the affected sections will just show empty.

If the precheck exits non-zero, surface the failed `✗` lines and their `→ hint` to the user verbatim and stop. Do **not** attempt to auto-fix (no `bun install`, no file fetches) — the hints are actionable steps the user takes themselves (e.g. installing bun, running `/stats` once in Claude Code to seed `stats-cache.json`).

Default port `5938`. This is an idempotent **ensure + open**: a PID file tracks the live instance, so re-running reuses an already-running dashboard (or supersedes a stale one from an out-of-date install) and opens `http://localhost:5938` in the default browser either way — fresh start or reuse. The dashboard is independent of the cockpit channel; nothing else starts it for you, so this skill owns its lifecycle.

Flags:
- `--port <n>` — pick a different port
- `--no-open` — skip auto-open (just print URL)

## Live Usage Limits

The dashboard's usage-window panel (5hr / weekly) is fed by `rate_limits` that
Claude Code only hands to the **status line** command. To capture it, point
`statusLine.command` in `~/.claude/settings.json` at `statusline-collector.ts`:
the collector reads the statusline JSON from stdin, writes
`~/.cache/token-atlas/rate-limits.json`, then forwards the unchanged payload to
its inner statusline (default `bunx -y ccstatusline@latest`; override with the
`TOKEN_ATLAS_STATUSLINE_COMMAND` env var to keep an existing line like
claude-powerline rendering).

**Don't hand-write the path.** The precheck (`install.ts`) reports whether the
collector is wired (the `○ live usage limits (statusline collector)` line). Use
its resolved path rather than `${CLAUDE_PLUGIN_ROOT}`: that variable is not
expanded in the status-line context, and installed plugins live at
version-pinned cache paths, so the absolute path must be resolved at runtime.
After `claude plugin update` the cache path changes; the precheck detects the
now-stale path, so re-running the dashboard re-surfaces the offer below.

## Optional Remote Usage Export

The statusline collector can also push the latest Claude + Codex usage-window
snapshot to a server such as an n8n webhook, so an external dashboard such as
TRMNL can display current quota/usage information. This is opt-in and only runs
when `LLM_QUOTA_INGEST_URL` is set in the statusline collector's environment.

When enabled, the detached background worker POSTs JSON containing:

- `capturedAt` — the export timestamp
- `claude` — the cached Claude statusline usage limits
- `codex` — the Codex usage limits from the local cache or Codex usage API

It does not send transcripts, message content, or project/session lists. If
`LLM_QUOTA_INGEST_SECRET` is set, it is sent as the `X-Auth-Token` header.

### Offer to wire it up

When the precheck shows the usage-limits check as `○` (not wired), **ask the
user with the `AskUserQuestion` tool** whether they want it set up automatically
— don't silently edit their global config. Offer these options:

- **Set it up for me** — run
  `bun ${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup-statusline.ts`, then
  relay its output. The script edits `~/.claude/settings.json`, backs it up to
  `settings.json.bak` first, preserves any existing status line by wrapping it
  via `TOKEN_ATLAS_STATUSLINE_COMMAND`, is idempotent, and refuses to touch the
  file if it isn't valid JSON. Tell the user to **restart Claude Code** for the
  new status line to take effect.
- **Show manual steps** — print the precheck's paste-ready `statusLine.command`
  hint verbatim and stop.
- **Skip** — launch the dashboard without usage limits; the panel stays empty.

## Sections

- **Provider switch** — All / Claude / Codex / OpenCode, with All as the combined default
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
usage-dashboard/
├── SKILL.md
├── scripts/
│   ├── api.ts                # data engine (also CLI: prints JSON)
│   ├── atlas-server.ts       # HTTP server + auto-open
│   └── statusline-collector.ts # captures live rate_limits and chains ccstatusline
│                             # (precheck install.ts + setup-statusline.ts now live in the install skill)
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
