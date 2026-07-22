# Herdr CLI Reference

Verified against herdr 0.7.5; if live CLI output disagrees with this doc, trust `herdr --help` / `herdr --default-config`.

Most commands output JSON for scripting.

## IDs are not durable

Workspace ids look like `1`, `2`; tab ids `1:1`, `1:2`; pane ids `1-1`, `1-2`. These are compact ids for the *current* live session — they renumber when workspaces/tabs/panes close. Don't reuse an id you saw earlier in a conversation; re-read it from `workspace list` / `tab list` / `pane list`, or from a create/split response, right before you use it. New ids appear at: `workspace create` → `result.workspace` / `result.tab` / `result.root_pane`; `tab create` → `result.tab` / `result.root_pane`; `pane split` → `result.pane.pane_id`.

## Launch & Status
```bash
herdr                           # launch or attach default session
herdr --session work            # named session
herdr --remote workbox          # SSH attach with local keybindings
herdr --remote workbox --remote-keybindings server
herdr --remote workbox --handoff
herdr --no-session              # single-process escape hatch
herdr --default-config          # print default config
herdr completion zsh|bash|fish|powershell|elvish
herdr update                    # install from configured channel
herdr update --handoff          # live handoff
herdr channel show
herdr channel set <stable|preview>
herdr --version
herdr status [server|client] [--json]
herdr api schema [--json | --output PATH]
```

## Server
```bash
herdr server                    # headless server (supervised setups)
herdr server stop
herdr server live-handoff       # hand off live panes to a new local server
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
herdr worktree list [--workspace ID | --cwd PATH] [--json]
herdr worktree create [--workspace ID | --cwd PATH] [--branch NAME] [--base REF] [--path PATH] [--label TEXT] [--focus|--no-focus] [--json]
herdr worktree open [--workspace ID | --cwd PATH] (--path PATH | --branch NAME) [--label TEXT] [--focus|--no-focus] [--json]
herdr worktree remove --workspace ID [--force] [--json]
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
herdr pane split [<id>|--pane ID|--current] --direction right|down [--ratio FLOAT] [--cwd PATH] [--env KEY=VALUE] [--focus|--no-focus]
herdr pane swap --direction left|right|up|down [--pane ID|--current]
herdr pane swap --source-pane ID --target-pane ID
herdr pane move <id> --tab <tab_id> --split right|down [--target-pane ID] [--ratio FLOAT] [--focus|--no-focus]
herdr pane move <id> --new-tab [--workspace ID] [--label TEXT] [--focus|--no-focus]
herdr pane move <id> --new-workspace [--label TEXT] [--tab-label TEXT] [--focus|--no-focus]
herdr pane close <id>
```

**Read output:**
```bash
herdr pane read <id> --source visible|recent|recent-unwrapped|detection [--lines N]
herdr pane read <id> --source visible --ansi
```

| Source | Meaning |
|---|---|
| `visible` | Current rendered screen |
| `recent` | Recent scrollback with wrapping |
| `recent-unwrapped` | Recent scrollback without soft wraps (best for logs) |
| `detection` | Bottom-buffer snapshot used by agent screen detection |

`herdr pane wait-output --source recent` matches against the **unwrapped** recent text (pane width/soft-wrapping don't affect the match) even though `pane read --source recent` displays the wrapped version. To see exactly what a wait matched against, read with `--source recent-unwrapped`. Use `pane read` for output that already exists; use `pane wait-output` for output you expect to appear next.

**Send input:**
```bash
herdr pane send-text <id> <text>
herdr pane send-keys <id> <key> [key ...]   # e.g. ctrl+h, enter, alt+x, f1, minus
herdr pane run <id> <command>                # text + Enter atomically (prefer over send-text + send-keys Enter)
```

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
herdr agent prompt <target> <text> [--wait] [--until <status>]... [--timeout MS]
herdr agent rename <target> <name>|--clear
herdr agent focus <target>
herdr agent wait <target> [--until idle|working|blocked|done|unknown]... [--timeout MS]
herdr agent attach <target> [--takeover]
herdr agent start <name> --kind <kind> --pane <pane_id> [--timeout MS] -- [agent_arg...]
herdr agent explain <target> [--json|--verbose]
herdr agent explain --file PATH --agent LABEL [--json|--verbose]
```

Agent kinds: `pi`, `claude`, `codex`, `gemini`, `cursor`, `devin`, `agy`, `cline`, `omp`, `mastracode`, `opencode`, `copilot`, `kimi`, `kiro`, `droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`, `maki`.

`agent prompt` atomically writes the text and presses Enter. `agent wait` accepts repeated `--until`; when omitted, it waits for `idle`, `done`, or `blocked`.

Targets: terminal IDs, unique agent names, detected/reported agent labels, or legacy pane IDs.

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
herdr pane wait-output <pane_id> <--match TEXT | --regex PATTERN> [--source visible|recent|recent-unwrapped] [--lines N] [--timeout MS] [--raw]
```

For agent-status waits, use `herdr agent wait <target> --until <status>` (see Agents). The old top-level `wait output` / `wait agent-status` commands were removed in 0.7.5.

## Notifications
```bash
herdr notification show <title> [--body TEXT] [--position top-left|top-right|bottom-left|bottom-right] [--sound none|done|request]
```

## Integrations
```bash
herdr integration install pi|omp|claude|codex|copilot|devin|droid|kimi|opencode|kilo|hermes|qodercli|cursor|mastracode
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

`popup` is session-modal and does not change the tab layout. Its size accepts cells or percentages such as `80%`; omitted dimensions default to half the terminal. A popup is not a Herdr pane, does not export `HERDR_PANE_ID`, and cannot be used with pane or agent APIs.

## Output format cheat sheet

- `workspace list/create`, `tab list/create/get/focus/rename/close`, `pane list/get/split/wait-output`, `agent wait` — print JSON on success.
- `pane read` — prints plain text, not JSON. `--format ansi` / `--ansi` returns a rendered ANSI snapshot for TUI feedback loops.
- `pane send-text`, `pane send-keys`, `pane run` — print nothing on success.
- `--no-focus` on `pane split` / `tab create` / `workspace create` keeps your current terminal focused instead of jumping to the new one.
- Without `--label`, `workspace create` keeps cwd-based naming and `tab create` keeps numbered naming; `--label` applies a custom name immediately.

For workflow examples that chain these commands together (spawning agents, waiting on servers/tests, coordinating between panes), see `agent-orchestration.md`.
