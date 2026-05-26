# cockpit

A per-project local web **cockpit** (one of two skills in the `monitor` plugin, alongside `usage-dashboard`): open a Claude Code or Codex session, set the goal, then watch the decision trail steer toward it in real time — keeping you "in the loop and in control". `usage-dashboard` is the rear-view mirror (retrospective, global usage); cockpit is the windshield + control stick (present + goal, per-project). It captures a goal at session start, appends a distilled decision log, streams the live transcript, and — at a `needs_your_call` — turns the LLM's options into buttons whose pick wakes the parked session.

Run the dashboard:

```bash
bun monitor/skills/cockpit/scripts/cockpit-server.ts
```

Provider support:

- Claude Code transcripts resolve from `~/.claude/projects/**/<session>.jsonl`.
- Codex transcripts resolve from `~/.codex/state_5.sqlite` thread rows and their rollout paths under `~/.codex/sessions`.
- The decision log, registry, and wait/send bridge are shared through `.cockpit/` and `~/.cockpit/`.

## Cockpit channel

The cockpit channel is Claude-only. The send box at the bottom of the Decision
Log column delivers text into a running Claude Code session; the agent's answers
come back through the Live Transcript, which the dashboard already renders — the
transcript is the single source of truth, so there is no separate reply tool or
strip. Codex has no channel hook, so Codex sessions stay observe-only.

Channels require Claude Code 2.1.80 or later and are still behind the research
preview development flag. Register the channel once in `~/.claude.json`:

```json
{
  "mcpServers": {
    "cockpit-channel": {
      "command": "bun",
      "args": [
        "/Users/funnyq/Projects/q-lab/cc-plugins/packages/monitor/skills/cockpit/scripts/cockpit-channel.ts"
      ]
    }
  }
}
```

Then launch an opted-in session with:

```bash
bun packages/monitor/skills/cockpit/scripts/monitor-up.ts
```

Extra arguments pass through to `claude`, so `bun
packages/monitor/skills/cockpit/scripts/monitor-up.ts --resume` keeps the same
foreground interactive behavior. For a shorter command:

```bash
alias cc='bun /Users/funnyq/Projects/q-lab/cc-plugins/packages/monitor/skills/cockpit/scripts/monitor-up.ts'
```

The channel only attaches to sessions launched with the development channel
flag. It cannot retro-attach to an already-running Claude Code session.
