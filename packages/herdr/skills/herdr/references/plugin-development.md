# Herdr Plugin Development

Verified against herdr 0.7.1; if live CLI output disagrees with this doc, trust `herdr --help` / `herdr --default-config`.

Plugins are shareable executable workflow packages. Any language — Bash, JS, Rust, Go, Lua, Python. Herdr owns the host surface; the plugin owns its implementation.

The entire Herdr CLI is the plugin API (see `cli.md`). Call back via `HERDR_BIN_PATH` (portable across Unix sockets and Windows named pipes).

## Manifest (`herdr-plugin.toml`)

```toml
id = "example.layout"
name = "Layout"
version = "0.1.0"
min_herdr_version = "0.7.0"
description = "Apply project layouts"
platforms = ["linux", "macos", "windows"]

[[build]]
command = ["npm", "ci"]

[[build]]
command = ["npm", "run", "build"]
platforms = ["linux", "macos"]

[[actions]]
id = "apply"
title = "Apply layout"
contexts = ["workspace"]
command = ["node", "dist/apply.js"]

[[events]]
on = "worktree.created"
command = ["herdr", "workspace", "list"]

[[panes]]
id = "board"
title = "Project board"
placement = "overlay"    # "overlay" | "split" | "tab" | "zoomed"
command = ["herdr-board"]

[[link_handlers]]
id = "github-issue"
title = "Open GitHub issue"
pattern = "^https://github\\.com/[^/]+/[^/]+/(issues|pull)/[0-9]+$"
action = "apply"
```

**Required fields:** `id`, `name`, `version`, `min_herdr_version`.
**ID rules:** Plugin id: ASCII letters, digits, dot, colon, underscore, hyphen. Action/pane/link-handler ids: same but no dots.
**Platforms:** Top-level applies to all; item-level overrides.
**Commands:** argv arrays, NOT shell-expanded.

## Runtime Environment Variables

Injected into all runtime commands:
- `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_ENV=1`
- `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`
- `HERDR_PLUGIN_CONTEXT_JSON` (workspace, tab, pane, agent, selected text, clicked URL, link handler fields when available)
- `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` (when available)

Action-specific: `HERDR_PLUGIN_ACTION_ID`
Event-specific: `HERDR_PLUGIN_EVENT`, `HERDR_PLUGIN_EVENT_JSON`
Pane-specific: `HERDR_PLUGIN_ENTRYPOINT_ID`
Link handler: `HERDR_PLUGIN_CLICKED_URL`, `HERDR_PLUGIN_LINK_HANDLER_ID`, `invocation_source = "link_click"`

## Storage Rules
- **Config** (`.env`, user-editable): `HERDR_PLUGIN_CONFIG_DIR`
- **Runtime state**: `HERDR_PLUGIN_STATE_DIR`
- **NOT in `HERDR_PLUGIN_ROOT`** — GitHub-installed roots are managed checkouts

## First Plugin Example

Directory structure:
```
my-plugin/
  herdr-plugin.toml
  index.js
```

Manifest:
```toml
id = "example.workspace-tools"
name = "Workspace Tools"
version = "0.1.0"
min_herdr_version = "0.7.0"
description = "Small workspace helper"
platforms = ["linux", "macos", "windows"]

[[actions]]
id = "list-workspaces"
title = "List workspaces"
contexts = ["workspace"]
command = ["node", "index.js"]
```

Script (`index.js`):
```js
const { spawnSync } = require("node:child_process");
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const result = spawnSync(herdr, ["workspace", "list"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
```

## Dev Workflow
```bash
# Link local plugin for development
herdr plugin link /path/to/plugin

# Get config dir
herdr plugin config-dir example.layout

# List actions
herdr plugin action list --plugin example.layout

# Invoke action
herdr plugin action invoke example.layout.apply

# Open plugin pane
herdr plugin pane open --plugin example.layout --entrypoint board

# View logs
herdr plugin log list --plugin example.layout

# Unlink (leaves files)
herdr plugin unlink example.layout
```

## Keybindings for Plugin Actions
```toml
[[keys.command]]
key = "prefix+l"
type = "plugin_action"
command = "example.layout.apply"    # qualified id when ambiguous
description = "apply layout"
```

## Install & Distribute
```bash
# Install from GitHub
herdr plugin install owner/repo[/subdir] [--ref REF] [--yes]

# Marketplace: add GitHub topic "herdr-plugin" to public repo
# Index refreshes every 30 minutes
```

## Pitfalls
- `command` is argv, not shell — no `$VAR` expansion, no pipes, no `&&`
- Build commands don't receive runtime env or socket
- `plugin link` does NOT run build commands — build yourself
- No `plugin update` in v1 — reinstall from GitHub to refresh
- Plugin ids can contain dots; action ids cannot — use qualified `plugin.id.action` for global uniqueness
- `HERDR_PLUGIN_ROOT` is a managed checkout for GitHub installs — never store user data there
- Windows: `PATHEXT` shims (`.cmd`) resolved automatically for build/action/event commands
