---
name: usage-dashboard
description: >-
  Launch a local web dashboard that visualizes Claude Code, Codex, and OpenCode
  usage — sessions, tokens, cost, model mix, activity heatmap, top projects.
when_to_use: >-
  When the user wants a visual breakdown of their AI coding usage, cost, or
  project activity — beyond the built-in /stats text output. Also known as
  "token atlas".
---

# AI Code Stats Dashboard

A petite-vue + Chart.js single-page dashboard served from a local Bun HTTP server. It reads `~/.claude/stats-cache.json`, `~/.claude/history.jsonl`, `~/.claude/projects/`, `~/.codex/state_5.sqlite`, `~/.codex/sessions/`, and OpenCode data under `${OPENCODE_DATA_DIR:-~/.local/share/opencode}/opencode.db`, with a legacy JSON fallback from `storage/` plus `project/*/storage/`. By default the dashboard is local-only. It performs no usage export unless `LLM_QUOTA_INGEST_URL` is explicitly configured. The dashboard consults OpenRouter opportunistically for live pricing; a failure there stays silent.

## Run

Run the precheck in the **foreground**. Its exit code is the gate.

```bash
bun <plugin-root>/skills/install/scripts/install.ts
```

If it exits 0, launch the server in the **background**.

```bash
bun <plugin-root>/skills/usage-dashboard/scripts/atlas-server.ts
```

The server holds the process open and never returns on its own. A foreground
launch blocks until the tool times out, then reports a failure for a dashboard
that is actually running fine. Under Claude Code, pass `run_in_background: true`
to the Bash tool. Under a harness with no background flag, detach it (`… &`).
Never chain the two commands with `&&` — that puts the precheck in the
background too and throws away the gate.

The server opens the browser itself. After launching, check the background output
once, then report the URL and stop. Do not poll the port and do not tail the
output — the process stays open by design.

One failure survives the precheck: a foreign process already holding the port.
The server prints `atlas: port <n> is in use by another process` and exits 1.
If you see that line, surface it and offer `--port <n>`. A port held by a
previous dashboard is not this case — the server reuses or supersedes it and
prints the URL as usual.

**`<plugin-root>`** resolves per runtime. Under Claude Code, use
`${CLAUDE_PLUGIN_ROOT}`. Under Codex, resolve it from the installed skill root
that contains this skill. In a development checkout of this repository,
`${CLAUDE_PLUGIN_ROOT}` is empty. Substitute `packages/monitor` from the repo
root instead, for example `bun packages/monitor/skills/usage-dashboard/scripts/atlas-server.ts`.
Under OpenCode, skills are installed at
`~/.config/opencode/skills/usage-dashboard/` (symlinked by
`opencode/install.ts`). Resolve scripts from there:
`bun ~/.config/opencode/skills/usage-dashboard/scripts/…`.
`CLAUDE_PLUGIN_ROOT` is empty under OpenCode — never use it.

### OpenCode — skip this section on Claude Code and Codex

OpenCode usage data is already read **natively**. The dashboard reads
`${OPENCODE_DATA_DIR:-~/.local/share/opencode}/opencode.db` through the shared
reader at `packages/monitor/skills/shared/scripts/opencode.ts`. Nothing has to
be installed for OpenCode sessions, tokens, and cost to show up — if they are
missing, the cause is the database, not a missing integration.

The precheck (`install.ts`, owned by the sibling `install` skill) verifies `bun`, vendor files, and Claude data sources. It distinguishes **required** failures (`✗`, exit 1) from **optional** ones (`○`, exit 0 with a notice). Optional gaps do **not** block the dashboard. A typical optional gap is a missing `history.jsonl`, because the user has not used Claude Code chat yet. The affected sections simply show empty.

If the precheck exits non-zero, surface the failed `✗` lines and their `→ hint` to the user verbatim. Then stop. Do **not** attempt to auto-fix: no `bun install`, no file fetches. The hints are actionable steps the user takes themselves, for example installing bun or running `/stats` once in Claude Code to seed `stats-cache.json`.

Default port: `5938`. This behavior is an idempotent **ensure + open**. A PID file tracks the live instance. Re-running reuses an already-running dashboard, or supersedes a stale one from an out-of-date install. Either way, it opens `http://localhost:5938` in the default browser. The dashboard is independent of the cockpit channel. Nothing else starts it for you, so this skill owns its lifecycle.

Flags:
- `--port <n>` — pick a different port
- `--no-open` — skip auto-open (just print URL)

## Live Usage Limits

Claude Code feeds the dashboard's usage-window panel (5hr / weekly) from
`rate_limits`. It hands `rate_limits` only to the **status line** command. To
capture it, point `statusLine.command` in `~/.claude/settings.json` at
`statusline-collector.ts`. The collector reads the statusline JSON from
stdin. It writes `~/.cache/token-atlas/rate-limits.json`. Then it forwards
the unchanged payload to its inner statusline (default
`bunx -y ccstatusline@latest`; override with the
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
snapshot to a server, for example an n8n webhook. An external dashboard, for
example TRMNL, can then display current quota and usage information. This
export is opt-in. It runs only when `LLM_QUOTA_INGEST_URL` is set in the
statusline collector's environment.

When enabled, the detached background worker POSTs JSON containing:

- `capturedAt` — the export timestamp
- `claude` — the cached Claude statusline usage limits
- `codex` — the Codex usage limits from the local cache or Codex usage API

It does not send transcripts, message content, or project/session lists. If
`LLM_QUOTA_INGEST_SECRET` is set, the collector sends it as the
`X-Auth-Token` header.

### Offer to wire it up

When the precheck shows the usage-limits check as `○` (not wired), **ask the
user with the `AskUserQuestion` tool** whether they want it set up
automatically. Do not silently edit their global config. Offer these
options:

- **Set it up for me** — run
  `bun ${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup-statusline.ts`, then
  relay its output. The script edits `~/.claude/settings.json`. It backs up
  the file to `settings.json.bak` first. It preserves any existing status
  line by wrapping it via `TOKEN_ATLAS_STATUSLINE_COMMAND`. The script is
  idempotent. It refuses to touch the file if the file isn't valid JSON.
  Tell the user to **restart Claude Code** for the new status line to take
  effect.
- **Show manual steps** — print the precheck's paste-ready
  `statusLine.command` hint verbatim. Then stop.
- **Skip** — launch the dashboard without usage limits. The panel stays
  empty.

## Pricing

Defaults ship in `references/pricing-defaults.json`. On startup, the server tries OpenRouter's `/api/v1/models` endpoint (3s timeout). It merges any live prices it gets. User overrides win. Drop a JSON file at `~/.config/cc-dashboard/pricing.json`:

```json
{
  "models": {
    "claude-opus-4-7": { "input": 5.00, "output": 25.00, "cacheRead": 0.50, "cacheWrite": 6.25 }
  }
}
```

For external (non-Anthropic) models without dedicated cache pricing, the dashboard counts cache tokens as input.

## Troubleshooting

- **Empty dashboard / "Missing or unreadable: stats-cache.json"** — open Claude Code. Run `/stats` once to seed the cache.
- **Port in use** — the script auto-kills whatever holds the port. If you would rather use a different port, pass `--port 9000` (or any free port).
- **No projects shown** — `history.jsonl` may be missing, or you've used Claude Code for less than a few sessions.
- **All costs look identical / wrong** — drop a custom pricing override at `~/.config/cc-dashboard/pricing.json`.
