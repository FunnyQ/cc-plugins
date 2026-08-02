---
name: herdr
description: >-
  Help with Herdr configuration, CLI, popup and tiled panes, plugins, and
  coordinating agents across panes.
when_to_use: >-
  For herdr config.toml, keybindings, themes, popup commands, CLI commands, or
  plugin development; or — inside a herdr pane (HERDR_ENV=1) — spawning,
  driving, or coordinating agents in other panes or tabs.
version: 1
---

# Herdr

Herdr is a terminal workspace manager with workspaces, tabs, split panes, agent detection, and a plugin system. It works without a config file. If you need customization, add `~/.config/herdr/config.toml`.

Docs: <https://herdr.dev/docs/>

## Orchestrating agents — use the `herd` wrapper first

Inside a herdr pane (`HERDR_ENV=1`) you may need to spawn or drive other agents. For that work, prefer the bundled `scripts/herd.ts` wrapper over hand-rolled raw `herdr` CLI chains.

The wrapper collapses herdr's multi-step recipes, for example create pane → start agent → prompt → wait → read, into seven typed verbs. It also handles the sharp edges for you. It addresses agents by a **collision-proof generated name**, never by non-durable pane ids. It creates the destination pane before `agent start`. It uses atomic `agent prompt` submission.

`${CLAUDE_PLUGIN_ROOT}` is not reliable inside an agent Bash call. Resolve the script instead from the load-time **"Base directory for this skill"** banner (`$SKILL_DIR/scripts/herd.ts`).

```bash
HERD="$SKILL_DIR/scripts/herd.ts"

# Spawn codex in a new pane (no focus), get back a unique name like "reviewer-a3f9"
bun "$HERD" spawn reviewer --agent codex --cwd "$PWD"

# Add --new-tab to open the agent in its own labelled tab; --tab-label overrides the default label.

# Spawn AND hand it a task in one shot (waits for idle, then sends + submits)
bun "$HERD" spawn reviewer --agent codex --task "review the diff in src/api/"

# Atomically send and submit a prompt to a running agent
bun "$HERD" send reviewer-a3f9 "now check error handling"

# Send bare key chords (no text) — submit what's in the box, or clear a line
bun "$HERD" keys reviewer-a3f9 enter
bun "$HERD" keys reviewer-a3f9 ctrl+a ctrl+k

# Block until it will accept input, then read its screen
bun "$HERD" wait reviewer-a3f9 --status idle --timeout 120000

# --status is repeatable. codex parks at `done`, so a "has it stopped" wait needs both.
bun "$HERD" wait reviewer-a3f9 --status idle --status done --timeout 120000
bun "$HERD" read reviewer-a3f9 --lines 60

bun "$HERD" list                 # all current agents as typed JSON
bun "$HERD" close reviewer-a3f9  # close the agent's pane
```

All verbs print JSON. The exception is `read`, which prints the pane's text. Agent TUIs render into the alternate-screen buffer. This leaves `recent`/`recent-unwrapped` empty. So `read` defaults to `--source visible`, the current screen. If you need a scrolled log tail, pass `--source recent-unwrapped`. `wait` takes the full herdr status enum, `done` included, and `--status` is repeatable — it becomes one `--until` per value. Its default stays `idle`, deliberately. `idle` is the only status meaning "the TUI will accept input", which is what a settle-before-send needs. herdr's own bare `agent wait` defaults to idle|done|blocked instead, but do not copy that set: `blocked` means the agent is parked on a human approval, so a wait returning there hands a stuck pane to an unattended caller. For "has it stopped", pass `--status idle --status done`. Treat even that as a hint, not proof — a fresh agent reports `idle` before its first turn, so a status wait alone cannot tell a finished agent from one that never started. Pair it with your own evidence, the way relay's `collect` gates on a result-file marker. Run tests with `bun test scripts/herd.test.ts`.

If the wrapper doesn't cover something, for example worktrees, layout, notifications, waiting on arbitrary pane output, or plugin panes, drop to the raw CLI. See `references/agent-orchestration.md` for live recipes. See `references/cli.md` for the full command surface.

## Reference files

This skill's detail lives in `references/`. Read only the file(s) relevant to the question, not all of them.

| File | Read when the user asks about... |
|---|---|
| `references/config.md` | `config.toml` sections, keybindings and popup commands, themes, toast/sound notifications, environment variables, `herdr server reload-config` |
| `references/cli.md` | Any `herdr <subcommand>` usage — session/workspace/tab/pane/agent management, waits, integrations, plugin CLI commands |
| `references/plugin-development.md` | Writing or debugging a Herdr plugin — `herdr-plugin.toml` manifest, runtime env vars, dev workflow (`plugin link`), distribution, pitfalls |
| `references/agent-orchestration.md` | Claude is running *inside* a herdr pane (`HERDR_ENV=1`) and needs to control herdr live — split panes, wait for output, spawn or coordinate with other agents |
| `references/socket-api.md` | Talking to herdr over `HERDR_SOCKET_PATH` instead of the CLI — envelope, framing rules, CLI↔method map, enum spelling traps, `events.subscribe` (the one thing the CLI cannot do) |

Most CLI commands output JSON for scripting. `herdr --default-config` prints the full default config as a starting point.
