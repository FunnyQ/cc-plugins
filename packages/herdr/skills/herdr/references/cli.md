# Herdr CLI Reference

This document is verified against herdr 0.8.2. If live CLI output disagrees with this doc, trust `herdr --skill` / `herdr --help`.

Most commands output JSON for scripting.

## IDs are stable opaque handles

Workspace, tab, and pane ids look like `w1`, `w1:t1`, and `w1:p1`. Closed ids are not reused. A cross-workspace `pane move` gives the pane a new workspace-qualified id; continue with `result.move_result.pane.pane_id` or its live agent name. The response keeps the old value at `result.move_result.previous_pane_id`. Creation responses expose new ids at `result.workspace`, `result.tab`, `result.root_pane`, or `result.pane`.

## Launch & Status
```bash
herdr                           # launch or attach default session
herdr --session work            # named session
herdr --remote workbox          # SSH attach with local keybindings
herdr --remote workbox --remote-keybindings server
herdr --remote workbox --handoff
herdr --no-session              # single-process escape hatch
herdr --default-config          # print default config
herdr --skill                   # print the agent guide bundled with this binary
herdr completion zsh|bash|fish|powershell|elvish
herdr update                    # install from configured channel
herdr update --handoff          # live handoff
herdr channel show
herdr channel set <stable|preview>
herdr --version
herdr status [server|client] [--json]
herdr api schema [--json | --output PATH]
herdr api snapshot              # live runtime state
herdr config check
herdr config reset-keys
```

`herdr --help` routes AI agents to two more sources. Read https://herdr.dev/agent-guide.md to help a human set Herdr up for the first time. Read https://herdr.dev/llms.txt to debug Herdr itself. Skip `herdr --skill` while this skill is in context.

## Server
```bash
herdr server                    # headless server (supervised setups)
herdr server stop
herdr server reload-config
herdr server agent-manifests [--json]
herdr server update-agent-manifests [--json]
herdr server reload-agent-manifests
```

## Sessions
```bash
herdr session list [--json]
herdr session attach <name>
herdr session stop <name> [--json]
herdr session delete <name> [--json]
```

## Workspaces
```bash
herdr workspace list
herdr workspace create [--cwd PATH] [--label TEXT] [--env KEY=VALUE] [--focus|--no-focus]
herdr workspace get <id>
herdr workspace focus <id>
herdr workspace rename <id> <label>
herdr workspace report-metadata <id> --source ID [--token NAME=VALUE] [--clear-token NAME] [--seq N] [--ttl-ms N]
herdr workspace close <id>
```

## Worktrees
```bash
herdr worktree list [--workspace ID | --cwd PATH]
herdr worktree create [--workspace ID | --cwd PATH] [--branch NAME] [--base REF] [--path PATH] [--label TEXT] [--focus|--no-focus]
herdr worktree open [--workspace ID | --cwd PATH] (--path PATH | --branch NAME) [--label TEXT] [--focus|--no-focus]
herdr worktree remove --workspace ID [--force]
```

## Tabs
```bash
herdr tab list [--workspace <id>]
herdr tab create [--workspace <id>] [--cwd PATH] [--label TEXT] [--env KEY=VALUE] [--focus|--no-focus]
herdr tab get <id>
herdr tab focus <id>
herdr tab rename <id> <label>
herdr tab close <id>
```

## Panes
```bash
herdr pane list [--workspace <id>]
herdr pane current [--pane ID|--current]
herdr pane get <id>
herdr pane layout [--pane ID|--current]
herdr pane process-info [--pane ID|--current]
herdr pane neighbor --direction left|right|up|down [--pane ID|--current]
herdr pane edges [--pane ID|--current]
herdr pane focus --direction left|right|up|down [--pane ID|--current]
herdr pane resize --direction left|right|up|down [--amount FLOAT] [--pane ID|--current]
herdr pane zoom [<pane_id>|--pane ID|--current] [--toggle|--on|--off]
herdr pane rename <id> <label>|--clear
herdr pane input [<id>|--pane ID|--current] --right-click herdr|pane
herdr pane split [<id>|--pane ID|--current] --direction right|down [--ratio FLOAT] [--cwd PATH] [--env KEY=VALUE] [--right-click herdr|pane] [--focus|--no-focus]
herdr pane swap --direction left|right|up|down [--pane ID|--current]
herdr pane swap --source-pane ID --target-pane ID
herdr pane move <id> --tab <tab_id> --split right|down [--target-pane ID] [--ratio FLOAT] [--focus|--no-focus]
herdr pane move <id> --new-tab [--workspace ID] [--label TEXT] [--focus|--no-focus]
herdr pane move <id> --new-workspace [--label TEXT] [--tab-label TEXT] [--focus|--no-focus]
herdr pane close <id>
```

`pane current`, `pane get`, and `pane layout --current` resolve the calling pane, not another client's focused pane.

Pass `--right-click pane` to forward unmodified right-click gestures to a mouse-reporting application inside the pane. Pass `--right-click herdr` to restore Herdr's pane menu. Right-clicking the pane frame still opens Herdr's menu. Set the same policy at creation with `pane split --right-click pane`.

**Read output:**
```bash
herdr pane read <id> [--source visible|recent|recent-unwrapped|detection] [--lines N] [--format text|ansi] [--ansi] [--raw]
herdr pane read <id> --source visible --ansi
```

| Source | Meaning |
|---|---|
| `visible` | Current rendered screen |
| `recent` | Recent scrollback with wrapping |
| `recent-unwrapped` | Recent scrollback without soft wraps (best for logs) |
| `detection` | Bottom-buffer snapshot used by agent screen detection |

`pane read` and `pane wait-output` accept `--flag=value` and take options before or after the pane id. `pane read` and `agent read` print plain text. Recent sources default to 80 rows when `--lines` is omitted. `visible` and `detection` return the full snapshot unless `--lines` limits them. An idle recognized agent at the transcript bottom can collect alternate-screen history when the requested line count exceeds its visible rows. A history request that needs this collection while the agent is working, blocked, or unknown returns `agent_not_idle`.

`herdr pane wait-output --source recent` matches against the **unwrapped** recent text. Pane width and soft-wrapping do not affect the match. This is true even though `pane read --source recent` displays the wrapped version. To see exactly what a wait matched against, read with `--source recent-unwrapped`. Use `pane read` for output that already exists. Use `pane wait-output` for output you expect to appear next.

**Send input:**
```bash
herdr pane send-text <id> <text>
herdr pane send-keys <id> <key> [key ...]   # e.g. ctrl+h, enter, alt+x, f1, minus
herdr pane run <id> <command>                # text + Enter atomically (prefer over send-text + send-keys Enter)
```

`pane send-keys` and `agent send-keys` preserve Shift for `shift+tab`, so agent permission modes cycle programmatically.

**Report agent state:**
```bash
herdr pane report-agent <id> \
  --source ID --agent LABEL \
  --state idle|working|blocked|unknown \
  [--message TEXT] [--seq N] \
  [--agent-session-id ID] [--agent-session-path PATH]
herdr pane report-agent-session <id> \
  --source ID --agent LABEL [--seq N] \
  [--agent-session-id ID] [--agent-session-path PATH]
herdr pane release-agent <id> --source ID --agent LABEL [--seq N]
```

**Report metadata (display-only):**
```bash
herdr pane report-metadata <id> \
  --source ID [--agent LABEL] [--applies-to-source ID] \
  [--title TEXT|--clear-title] [--display-agent TEXT|--clear-display-agent] \
  [--state-label STATUS=TEXT] [--clear-state-labels] \
  [--token NAME=VALUE] [--clear-token NAME] \
  [--seq N] [--ttl-ms N]
```

## Agents
```bash
herdr agent list
herdr agent get <target>
herdr agent read <target> [--source visible|recent|recent-unwrapped|detection] [--lines N] [--format text|ansi] [--ansi]
herdr agent send-keys <target> <key> [key ...]
herdr agent prompt <target> <text> [--wait] [--until STATUS]... [--timeout MS]
herdr agent rename <target> <name>|--clear
herdr agent focus <target>
herdr agent wait <target> [--until idle|working|blocked|done|unknown]... [--timeout MS]
herdr agent attach <target> [--takeover]
herdr agent start <name> --kind KIND --pane ID [--timeout MS] [-- <agent-args...>]
herdr agent explain <target> [--json|--format text|json] [--verbose]
herdr agent explain --file PATH --agent LABEL [--json|--format text|json] [--verbose]
```

Agent kinds: `pi`, `claude`, `codex`, `gemini`, `cursor`, `devin`, `agy`, `cline`, `omp`, `mastracode`, `opencode`, `copilot`, `kimi`, `kiro`, `droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`, `qwen`, `maki`.

`agent prompt` handles bracketed paste, waits briefly after writing text, and then presses Enter. When the agent already sits at an approval or question dialog, `agent prompt` fails with `agent_blocked` and sends neither text nor Enter. Inspect the dialog and ask the user before answering it. `agent wait` accepts a repeated `--until` flag. When you omit `--until`, `agent wait` waits for `idle`, `done`, or `blocked`.

`agent prompt --wait` settles in the same call. It rejects `--until` unless `--wait` is also present. An accepted prompt sent from a non-working state must produce an observed lifecycle change within five seconds, or herdr returns `agent_prompt_stalled` — the agent took the text and never acted on it. Set `--timeout` above 5000 to keep that error distinct; at or below it herdr reports a plain `timeout` instead. Once activity is observed, the wait tracks lifecycle state, not one turn, so an already-working agent can satisfy it by finishing its current turn.

`agent start` waits for the new pane shell and the first-run agent prompt to be ready before returning. Startup defaults to a 30000 ms timeout; `--timeout` accepts values above 3000 and up to 300000. When detection reports `blocked` during startup, `agent start` returns `agent_not_ready` immediately — the name still resolves for `agent read` and `agent send-keys`, so clear the dialog and prompt once the agent reports `idle`.

`agent explain` classifies against the **running server's** manifest cache. After upgrading the herdr binary, restart or hand off the server before trusting live explain output. Compare the two versions with `herdr status`.

Targets: a unique live agent name or the pane id currently hosting that agent.

## Direct Terminal Attach
```bash
herdr terminal attach <terminal_id> [--takeover]
herdr terminal session control <target> [--takeover] [--cols N] [--rows N]
herdr terminal session observe <target> [--cols N] [--rows N]
herdr terminal title set <title>
herdr terminal title clear
# Detach: ctrl+b q  |  Send literal ctrl+b: ctrl+b ctrl+b
```

## Waits
```bash
herdr pane wait-output <pane_id> (--match TEXT | --regex PATTERN) [--source visible|recent|recent-unwrapped] [--lines N] [--timeout MS] [--raw]
```

For agent-status waits, use `herdr agent wait <target> --until <status>` (see Agents). Herdr removed the old top-level `wait output` / `wait agent-status` commands in 0.7.5.

## Notifications
```bash
herdr notification show <title> [--body TEXT] [--position top-left|top-right|bottom-left|bottom-right] [--sound none|done|request]
```

## Integrations
```bash
herdr integration install pi|omp|claude|codex|copilot|devin|droid|kimi|opencode|kilo|hermes|qodercli|qwen|cursor|mastracode|antigravity-cli|grok
herdr integration uninstall <name>
herdr integration status [--outdated-only]
```

## Plugins (CLI)
```bash
herdr plugin install <owner>/<repo>[/subdir...] [--ref REF] [--yes]
herdr plugin list [--plugin ID] [--json]
herdr plugin uninstall <plugin_id|owner/repo[/subdir...]>
herdr plugin enable <plugin_id>
herdr plugin disable <plugin_id>
herdr plugin link <path> [--disabled]       # local dev
herdr plugin unlink <plugin_id>
herdr plugin config-dir <plugin_id>         # print config dir (creates if needed)
herdr plugin action list [--plugin ID]
herdr plugin action invoke <action_id> [--plugin ID]
herdr plugin log list [--plugin ID] [--limit N]
herdr plugin pane open --plugin ID --entrypoint ID [--placement overlay|popup|split|tab|zoomed] [--width SIZE] [--height SIZE] [--workspace ID] [--target-pane PANE] [--direction right|down] [--cwd PATH] [--env KEY=VALUE] [--focus|--no-focus]
herdr plugin pane focus <pane_id>
herdr plugin pane close <pane_id>
```

`popup` is session-modal. It does not change the tab layout. Its size accepts cells or percentages such as `80%`. If you omit a dimension, it defaults to half the terminal. A popup is not a Herdr pane. It does not export `HERDR_PANE_ID`. You cannot use a popup with pane or agent APIs.

## Output format cheat sheet

- `workspace list/create`, `tab list/create/get/focus/rename/close`, `pane list/get/split/wait-output`, `agent wait` — print JSON on success.
- `pane read` and `agent read` — print plain text, not JSON. `--format ansi` / `--ansi` returns a rendered ANSI snapshot for TUI feedback loops.
- `pane send-text`, `pane send-keys`, `pane run` — print nothing on success.
- `pane split` / `tab create` / `workspace create` leave focus unchanged by default. `--focus` jumps to the new layout; `--no-focus` states the default explicitly.
- Without `--label`, `workspace create` keeps cwd-based naming, and `tab create` keeps numbered naming. `--label` applies a custom name immediately.

For workflow examples that chain these commands together (spawning agents, waiting on servers or tests, coordinating between panes), see `agent-orchestration.md`.

Socket commands return JSON errors on stderr with exit status 1, including `server_not_running` when no compatible server is available. CLI usage errors exit with status 2. On Unix, a closed downstream pipe exits quietly, so piping into `head` is safe.
