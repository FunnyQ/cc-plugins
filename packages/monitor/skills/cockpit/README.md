# cockpit

A per-project local web **cockpit** (one of two skills in the `monitor` plugin, alongside `usage-dashboard`): open a Claude Code or Codex session, set the goal, then watch the decision trail steer toward it in real time — keeping you "in the loop and in control". `usage-dashboard` is the rear-view mirror (retrospective, global usage); cockpit is the windshield + control stick (present + goal, per-project). It captures a goal at session start, appends a distilled decision log, streams the live transcript, and — at a `needs_your_call` — turns the LLM's options into buttons whose pick wakes the parked session.

Run the dashboard:

```bash
bun monitor/skills/cockpit/scripts/cockpit-server.ts
```

Provider support:

- Claude Code transcripts resolve from `~/.claude/projects/**/<session>.jsonl`.
- Codex transcripts resolve from `~/.codex/state_5.sqlite` thread rows and their rollout paths under `~/.codex/sessions`.
- The decision log lives per-project under `.cockpit/`; the registry and wait/send bridge are shared through `~/.local/share/q-lab/cockpit/`.

## Cockpit channel

The send box at the bottom of the Decision Log column delivers text into a
running session. The agent's answers come back through the Live Transcript,
which the dashboard already renders — the transcript is the single source of
truth, so there is no separate reply tool or strip.

Provider behavior differs:

- **Claude Code** uses the cockpit channel MCP server and only attaches to
  sessions launched with the development channel flag.
- **Codex** uses the managed Codex remote-control daemon. Cockpit connects to
  the local app-server control socket, resumes the selected thread, and submits
  or steers a turn. Direct app-server is kept only as a fallback when
  remote-control is unavailable.

Channels require Claude Code 2.1.80 or later and are still behind the research
preview development flag. The channel is packaged in the plugin manifest
(`mcpServers` + `channels` in `.claude-plugin/plugin.json`), so Claude Code
auto-loads it when the `monitor` plugin is enabled — no manual `~/.claude.json`
entry is needed. (Older versions wired it by hand; `monitor:install` removes any
such stale entry to avoid double registration.)

Launch an opted-in session with:

```bash
bun packages/monitor/skills/cockpit/scripts/monitor-up.ts
```

Extra arguments pass through to `claude`, so `bun
packages/monitor/skills/cockpit/scripts/monitor-up.ts --resume` keeps the same
foreground interactive behavior. For a shorter command:

```bash
alias cc='bun /Users/funnyq/Projects/q-lab/cc-plugins/packages/monitor/skills/cockpit/scripts/monitor-up.ts'
```

The Claude channel only attaches to sessions launched with the development
channel flag. It cannot retro-attach to an already-running Claude Code session.

For Codex, install and enable the managed standalone Codex remote-control
daemon:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex app-server daemon enable-remote-control
```

Cockpit probes `/api/codex-control/status` before enabling the Codex send box,
so stale or non-resumable threads stay disabled.
