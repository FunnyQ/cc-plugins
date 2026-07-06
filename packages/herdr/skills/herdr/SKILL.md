---
name: herdr
description: "Herdr terminal workspace manager: use for herdr config / config.toml, keybindings, themes, CLI commands, plugin development, and — when running inside a herdr pane (HERDR_ENV=1) — spawning, driving, or coordinating agents in other panes or tabs."
version: 1
---

# Herdr

Herdr is a terminal workspace manager with workspaces, tabs, split panes, agent detection, and a plugin system. It works without a config file; add `~/.config/herdr/config.toml` when you need customization.

Docs: <https://herdr.dev/docs/>

## Orchestrating agents — use the `herd` wrapper first

When you are inside a herdr pane (`HERDR_ENV=1`) and need to spawn or drive other agents, prefer the bundled `scripts/herd.ts` wrapper over hand-rolling raw `herdr` CLI chains. It collapses herdr's multi-step recipes (split → parse pane id → send text → press Enter → wait → read) into seven typed verbs and handles the sharp edges for you: it addresses agents by a **collision-proof generated name** (never by non-durable pane ids), and its `send` writes the prompt **and presses Enter** (raw `agent send` only writes literal text).

Resolve the script from the load-time **"Base directory for this skill"** banner (`$SKILL_DIR/scripts/herd.ts`); `${CLAUDE_PLUGIN_ROOT}` is not reliable inside an agent Bash call.

```bash
HERD="$SKILL_DIR/scripts/herd.ts"

# Spawn codex in a new pane (no focus), get back a unique name like "reviewer-a3f9"
bun "$HERD" spawn reviewer --agent codex --cwd "$PWD"

# Add --new-tab to open the agent in its own labelled tab; --tab-label overrides the default label.

# Spawn AND hand it a task in one shot (waits for idle, then sends + submits)
bun "$HERD" spawn reviewer --agent codex --task "review the diff in src/api/"

# Send a prompt to a running agent and submit it (Enter). --no-submit to stage only
bun "$HERD" send reviewer-a3f9 "now check error handling"

# Send bare key chords (no text) — submit what's in the box, or clear a line
bun "$HERD" keys reviewer-a3f9 enter
bun "$HERD" keys reviewer-a3f9 ctrl+a ctrl+k

# Block until it settles, then read its screen
bun "$HERD" wait reviewer-a3f9 --status idle --timeout 120000
bun "$HERD" read reviewer-a3f9 --lines 60

bun "$HERD" list                 # all current agents as typed JSON
bun "$HERD" close reviewer-a3f9  # close the agent's pane
```

All verbs print JSON except `read` (prints the pane's text). `read` defaults to `--source visible` (the current screen) because agent TUIs render into the alternate-screen buffer, leaving `recent`/`recent-unwrapped` empty; pass `--source recent-unwrapped` for a scrolled log tail. The wrapper's `wait` cannot wait for status `done`; only raw `herdr wait agent-status <pane> --status done` supports the common "block until the other agent finishes" case. Run tests with `bun test scripts/herd.test.ts`.

For anything the wrapper doesn't cover (worktrees, layout, notifications, waiting on arbitrary pane output, plugin panes), drop to the raw CLI — see `references/agent-orchestration.md` for live recipes and `references/cli.md` for the full command surface.

## Reference files

This skill's detail lives in `references/` — read only the file(s) relevant to the question, not all of them.

| File | Read when the user asks about... |
|---|---|
| `references/config.md` | `config.toml` sections, keybindings config, themes, toast/sound notifications, environment variables, `herdr server reload-config` |
| `references/cli.md` | Any `herdr <subcommand>` usage — session/workspace/tab/pane/agent management, waits, integrations, plugin CLI commands |
| `references/plugin-development.md` | Writing or debugging a Herdr plugin — `herdr-plugin.toml` manifest, runtime env vars, dev workflow (`plugin link`), distribution, pitfalls |
| `references/agent-orchestration.md` | Claude is running *inside* a herdr pane (`HERDR_ENV=1`) and needs to control herdr live — split panes, wait for output, spawn or coordinate with other agents |

Most CLI commands output JSON for scripting; `herdr --default-config` prints the full default config as a starting point.
