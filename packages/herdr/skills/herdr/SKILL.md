---
name: herdr
description: >-
  Help with Herdr configuration, CLI, popup and tiled panes, plugins, and
  coordinating agents across panes.
when_to_use: >-
  For herdr config.toml, keybindings, themes, popup commands, CLI commands, or
  plugin development; or — inside a herdr pane (HERDR_ENV=1) — spawning,
  driving, or coordinating agents in other panes or tabs. Handing work to an
  agent already running in another project belongs to the `tell` skill, and
  getting an ANSWER back from one belongs to the `ask` skill — not this one.
version: 3
---

# Herdr

Herdr is a terminal workspace manager with workspaces, tabs, split panes, agent detection, and a plugin system. It works without a config file. If you need customization, add `~/.config/herdr/config.toml`.

Docs: <https://herdr.dev/docs/>. For an agent-readable index pinned to the installed release, fetch <https://herdr.dev/llms.txt> and open only the page the task needs. Run `herdr --skill` for the agent guide bundled with the installed binary; it is authoritative when this skill and the live CLI disagree.

## Orchestrating agents — use the `herd` wrapper first

Inside a herdr pane (`HERDR_ENV=1`), use the bundled `scripts/herd.ts` wrapper instead of hand-rolled raw `herdr` CLI chains. It collapses create-pane → start → prompt → wait → read into ten typed verbs, and addresses agents by a generated name that survives a cross-workspace pane-id change.

`${CLAUDE_PLUGIN_ROOT}` is not reliable inside an agent Bash call. Resolve the script instead from the load-time **"Base directory for this skill"** banner (`$SKILL_DIR/scripts/herd.ts`).

```bash
HERD="$SKILL_DIR/scripts/herd.ts"

# Spawn codex in a new pane (no focus), get back a unique name like "reviewer-a3f9"
bun "$HERD" spawn reviewer --agent codex --cwd "$PWD"

# Add --new-tab to open the agent in its own labelled tab; --tab-label overrides the default label.
# Add --new-workspace instead to open it in a FRESH workspace (a different project needs its own,
# never a tab in the caller's) — wins over --new-tab.

# Spawn AND hand it a task in one shot (waits for idle, then sends + submits)
bun "$HERD" spawn reviewer --agent codex --task "review the diff in src/api/"

# Hand work to an agent already running in ANOTHER project, fire-and-forget.
# No live agent matches? Falls back to the project registry, then zoxide, and
# auto-spawns one. See the `tell` skill for the fallback chain and addressing rules.
bun "$HERD" tell api-service "rebase onto main and run the suite"

# Slash-narrow when one project runs several agents
bun "$HERD" tell web-app/dashboard "restart the dev server"

# Ask a question and get the ANSWER back — same addressing/fallback as tell, but
# blocks up to 10 min. ALWAYS run via Bash with run_in_background: true.
# See the `ask` skill before using this.
bun "$HERD" ask api-service "what port does the dev server run on?"

# Flags go BEFORE the fragment (see the `ask` skill — a trailing flag is
# silently swallowed into the question).
bun "$HERD" ask --keep-pane diqi "what directory are you in?"

# Timed out while still working? Redeem it later without re-asking.
bun "$HERD" collect diqi-90d4 --result /tmp/herd-ask/.../result.md

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

To hand off work to a DIFFERENT project, use `tell`; use `ask` instead when you need an ANSWER back. Reach for `spawn` directly only when you want an agent in THIS session's own workspace (a helper, a reviewer, a second pane on the current repo). Read the **`tell` skill** before using either, and the **`ask` skill** on top of it for `ask`.

All verbs print JSON except `read`, which prints the agent's terminal text. It defaults to `--source visible`; pass `--source recent-unwrapped --lines N` for a longer transcript. Herdr 0.8.2 collects alternate-screen history only when the agent is recognized, idle, at the transcript bottom, and `N` exceeds the visible rows — otherwise an explicit history read may return `agent_not_idle`.

`send` fails with `agent_blocked` when the agent is parked on an approval or question dialog — herdr sends neither the text nor the Enter. Read the pane, then answer with `keys`; do not retry `send` until the block clears. `spawn --task` reports the same block instead of throwing: check `task: {"sent": false, "reason": "agent_blocked"}` before assuming the task landed. A trust dialog during startup gets the same treatment (`startBlocked: true`, task skipped) — a live name, not a thrown error.

`send` takes `--wait` / `--status` / `--timeout` to collapse a send-then-wait pair into one call; either of the latter two implies `--wait`. Put these flags **before** the target — everything from the target onward is positional, which keeps prompt text like `"--please fix this"` intact. Prefer the waiting form: a prompt accepted from a non-working state that produces no lifecycle change within five seconds fails with `agent_prompt_stalled` (the agent took the text and never acted on it) — a separate `wait` cannot tell you that. Keep `--timeout` above 5000, or herdr reports a plain `timeout` and loses that distinction.

`wait` takes the full status enum and a repeatable `--status` (one `--until` per value). Its default is `idle` — the only status meaning "ready for input". Never wait on `blocked`: it hands a stuck pane to an unattended caller. For "has it stopped", pass `--status idle --status done` — codex parks at `done`, not `idle`. Treat even that as a hint: a fresh agent also reports `idle` before its first turn. Pair it with your own evidence, such as a result-file marker.

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

`--agent opencode` is a valid agent kind: `bun "$SKILL_DIR/scripts/herd.ts" spawn <name> --agent opencode --cwd "$PWD"`.
