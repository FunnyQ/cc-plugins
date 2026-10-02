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

A petite-vue + Chart.js single-page dashboard served by `cockpit atlas serve`, a subcommand of the monitor plugin's Rust `cockpit` binary. It reads `~/.claude/stats-cache.json`, `~/.claude/history.jsonl`, `~/.claude/projects/`, `~/.codex/state_5.sqlite`, `~/.codex/sessions/`, and OpenCode data under `${OPENCODE_DATA_DIR:-~/.local/share/opencode}/opencode.db`, with a legacy JSON fallback from `storage/` plus `project/*/storage/`. By default the dashboard is local-only. It performs no usage export unless `LLM_QUOTA_INGEST_URL` is explicitly configured. The dashboard consults OpenRouter opportunistically for live pricing; a failure there stays silent.

## Run

Run the precheck in the **foreground**. Its exit code is the gate.

```bash
bun <plugin-root>/skills/install/scripts/install.ts
```

If it exits 0, launch the server in the **background**.

```bash
<plugin-root>/skills/cockpit/bin/cockpit atlas serve
```

`skills/cockpit/bin/cockpit` is the plugin's shim: it runs the `cockpit` binary
for this plugin version, downloading it on first use. Call it directly, not
through `bun`.

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

**`<plugin-root>`** resolves per runtime. Under Claude Code, it is the "Base
directory for this skill" path with `/skills/usage-dashboard` removed. Under
Codex, resolve it from the installed skill root that contains this skill. In a
development checkout of this repository, use `packages/monitor` from the repo
root.

**OpenCode only** — skip on Claude Code and Codex: follow
`~/.config/opencode/skills/usage-dashboard/references/opencode.md`. The path is
absolute because OpenCode prints no skill base-directory banner.

The precheck (`install.ts`, owned by the sibling `install` skill) verifies `bun`, vendor files, and Claude data sources. It distinguishes **required** failures (`✗`, exit 1) from **optional** ones (`○`, exit 0 with a notice). Optional gaps do **not** block the dashboard. A typical optional gap is a missing `history.jsonl`, because the user has not used Claude Code chat yet. The affected sections simply show empty.

If the precheck exits non-zero, surface the failed `✗` lines and their `→ hint` to the user verbatim. Then stop. Do **not** attempt to auto-fix: no `bun install`, no file fetches. The hints are actionable steps the user takes themselves, for example installing bun or running `/stats` once in Claude Code to seed `stats-cache.json`.

Default port: `5938`. This behavior is an idempotent **ensure + open**. A PID file tracks the live instance. Re-running reuses an already-running dashboard, or supersedes a stale one from an out-of-date install. Either way, it opens `http://localhost:5938` in the default browser. The dashboard is independent of the cockpit daemon and the monitor mod. Nothing else starts it for you, so this skill owns its lifecycle.

Flags:
- `--port <n>` — pick a different port
- `--no-open` — skip auto-open (just print URL)

## Live Usage Limits

The usage-window panel (5hr / weekly) reads
`~/.cache/token-atlas/rate-limits.json`. On Claude Code, the monitor mod's
`session.measure` hook fills it. The engine fires that hook after each
main-thread turn and whenever a rate-limit window moves a whole point. The
hook pipes the windows to `cockpit atlas measure`, which writes the cache.
Nothing needs wiring, and your statusline stays yours.

A statusline wired by an older plugin version still runs the retired
collector (`cockpit atlas statusline`). monitor's SessionStart hook unwraps it
once, on the first session after the plugin updates, back to the command it
forwarded to. It never adds a statusline you did not have.

## Optional Remote Usage Export

`cockpit atlas measure` can also push the latest Claude + Codex usage-window
snapshot to a server, for example an n8n webhook. An external dashboard, for
example TRMNL, can then display current quota and usage information. This
export is opt-in. It runs only when `LLM_QUOTA_INGEST_URL` is set in Claude
Code's environment, which the hook's child process inherits.

When enabled, the detached background worker POSTs JSON containing:

- `capturedAt` — the export timestamp
- `claude` — the cached Claude usage limits
- `codex` — the Codex usage limits from the local cache or Codex usage API

It does not send transcripts, message content, or project/session lists. If
`LLM_QUOTA_INGEST_SECRET` is set, the worker sends it as the
`X-Auth-Token` header.

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
- **Port in use** — a previous dashboard is reused or superseded automatically; a foreign process makes the server exit 1. Pass `--port <n>` with a free port.
- **No projects shown** — `history.jsonl` may be missing, or you've used Claude Code for less than a few sessions.
- **All costs look identical / wrong** — drop a custom pricing override at `~/.config/cc-dashboard/pricing.json`.
