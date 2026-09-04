---
name: herdr
description: >-
  Help with Herdr configuration, CLI, popup and tiled panes, plugins, and
  coordinating agents across panes.
when_to_use: >-
  For herdr config.toml, keybindings, themes, popup commands, CLI commands, or
  plugin development; or — inside a herdr pane (HERDR_ENV=1) — spawning,
  driving, or coordinating agents in other panes or tabs.
version: 2
---

# Herdr

Herdr is a terminal workspace manager with workspaces, tabs, split panes, agent detection, and a plugin system. It works without a config file. If you need customization, add `~/.config/herdr/config.toml`.

Docs: <https://herdr.dev/docs/>. For an agent-readable index pinned to the installed release, fetch <https://herdr.dev/llms.txt> and open only the page the task needs. Run `herdr --skill` for the agent guide bundled with the installed binary; it is authoritative when this skill and the live CLI disagree.

## Orchestrating agents — use the `herd` wrapper first

Inside a herdr pane (`HERDR_ENV=1`) you may need to spawn or drive other agents. For that work, prefer the bundled `scripts/herd.ts` wrapper over hand-rolled raw `herdr` CLI chains.

The wrapper collapses herdr's multi-step recipes, for example create pane → start agent → prompt → wait → read, into eight typed verbs. It also handles the sharp edges for you. It addresses agents by a **collision-proof generated name**, which follows an agent if a cross-workspace move changes its pane id. It creates the destination pane before `agent start`. It uses `agent prompt`, which handles paste mode and submission timing in one command.

`${CLAUDE_PLUGIN_ROOT}` is not reliable inside an agent Bash call. Resolve the script instead from the load-time **"Base directory for this skill"** banner (`$SKILL_DIR/scripts/herd.ts`).

```bash
HERD="$SKILL_DIR/scripts/herd.ts"

# Spawn codex in a new pane (no focus), get back a unique name like "reviewer-a3f9"
bun "$HERD" spawn reviewer --agent codex --cwd "$PWD"

# Add --new-tab to open the agent in its own labelled tab; --tab-label overrides the default label.

# Spawn AND hand it a task in one shot (waits for idle, then sends + submits)
bun "$HERD" spawn reviewer --agent codex --task "review the diff in src/api/"

# Hand work to an agent already running in ANOTHER project, fire-and-forget
bun "$HERD" tell api-service "rebase onto main and run the suite"

# Slash-narrow when one project runs several agents
bun "$HERD" tell web-app/dashboard "restart the dev server"

# Atomically send and submit a prompt to a running agent
bun "$HERD" send reviewer-a3f9 "now check error handling"

# Send AND settle in one round trip. Flags go BEFORE the target.
bun "$HERD" send --status idle --status done --timeout 120000 reviewer-a3f9 "now check error handling"

# Send bare key chords (no text) — submit what's in the box, or clear a line
bun "$HERD" keys reviewer-a3f9 enter
bun "$HERD" keys reviewer-a3f9 ctrl+a ctrl+k

# Answer an approval dialog, or cycle the agent's permission mode
bun "$HERD" keys reviewer-a3f9 shift+tab

# Block until it will accept input, then read its screen
bun "$HERD" wait reviewer-a3f9 --status idle --timeout 120000

# --status is repeatable. codex parks at `done`, so a "has it stopped" wait needs both.
bun "$HERD" wait reviewer-a3f9 --status idle --status done --timeout 120000
bun "$HERD" read reviewer-a3f9 --lines 60

bun "$HERD" list                 # all current agents, each with its workspace/tab address
bun "$HERD" close reviewer-a3f9  # close the agent's pane
```

Use `tell` to hand work to an agent that is *already running*; use `spawn` only when no agent is there yet. It addresses agents by workspace label — the project name — refuses to send when the fragment is ambiguous, and does not wait for an answer. The **`tell` skill** owns those rules and the safety bar for prompting another project's agent; read it before using this verb.

All verbs print JSON. The exception is `read`, which prints the agent's terminal text. It defaults to `--source visible`, which works while an agent is active. For a longer transcript, pass `--source recent-unwrapped --lines N`. Herdr 0.8.2 can collect alternate-screen history when the agent is recognized, idle, at the transcript bottom, and `N` exceeds the visible rows; otherwise an explicit history read may return `agent_not_idle`. `send` fails with `agent_blocked` when the agent is parked on an approval or question dialog, and herdr sends nothing — not the text, not the Enter. Read the pane, then answer the dialog with `keys`. Do not retry `send` until the block clears. `spawn --task` does not fail on that block — it returns `task: {"sent": false, "reason": "agent_blocked"}` beside the generated name, so check the flag before you assume the task landed. An agent that parks on a trust dialog during startup gets the same treatment: `spawn` returns `startBlocked: true` with a live name instead of throwing, and skips the task. Never assume `spawn` succeeding means the task was delivered. `send` takes `--wait` / `--status` / `--timeout` and collapses a send-then-wait pair into one call; either of the latter two implies `--wait`. Put those flags **before** the target — everything from the target onward is positional, which is what keeps prompt text like `"--please fix this"` intact. Prefer the waiting form for its one extra signal: a prompt accepted from a non-working state that produces no lifecycle change within five seconds fails with `agent_prompt_stalled`, meaning the agent took the text and never acted on it. A separate `wait` cannot tell you that. Keep `--timeout` above 5000; at or below it herdr reports a plain `timeout` and the distinction is lost. `wait` takes the full herdr status enum, `done` included, and `--status` is repeatable — it becomes one `--until` per value. Its default stays `idle`, deliberately. `idle` is the only status meaning "the TUI will accept input", which is what a settle-before-send needs. herdr's own bare `agent wait` defaults to idle|done|blocked instead, but do not copy that set: `blocked` means the agent is parked on a human approval, so a wait returning there hands a stuck pane to an unattended caller. For "has it stopped", pass `--status idle --status done`. Treat even that as a hint, not proof — a fresh agent reports `idle` before its first turn, so a status wait alone cannot tell a finished agent from one that never started. Pair it with your own evidence, the way relay's `collect` gates on a result-file marker. Run tests with `bun test scripts/herd.test.ts`.

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

## OpenCode only — skip on Claude Code and Codex

There is no banner and `CLAUDE_PLUGIN_ROOT` is empty. Set the path directly:

```bash
SKILL_DIR=~/.config/opencode/skills/herdr
bun "$SKILL_DIR/scripts/herd.ts" list
```

Herdr panes support an OpenCode agent kind, spawnable as `--agent opencode` (`bun "$SKILL_DIR/scripts/herd.ts" spawn <name> --agent opencode --cwd "$PWD"`) — verified by spawning a pane, confirming `list` reported it with `type: "opencode"`, and closing it. There is no type union to cross-check the agent kind against: `scripts/herd.ts` types it as plain `string`, and `claude|codex|opencode` appears only in comments.
