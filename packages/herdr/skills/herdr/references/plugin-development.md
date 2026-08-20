# Herdr Plugin Development

This document is verified against herdr 0.8.2. If live CLI output disagrees with this doc, trust `herdr --help`.

Plugins are shareable executable workflow packages. You can write a plugin in any language, for example Bash, JS, Rust, Go, Lua, or Python. Herdr owns the host surface. The plugin owns its implementation.

The entire Herdr CLI is the plugin API (see `cli.md`). Call back via `HERDR_BIN_PATH` (portable across Unix sockets and Windows named pipes).

The CLI is itself a thin client over herdr's socket at `HERDR_SOCKET_PATH`, so it exposes almost the whole API. The exception is event streaming, which has no subcommand. Read `socket-api.md` if you need `events.subscribe`, or if a hot loop makes the per-spawn cost matter.

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

[[startup]]
command = ["node", "dist/restore.js"]

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
placement = "overlay"    # default; also "popup" | "split" | "tab" | "zoomed"
command = ["herdr-board"]

[[link_handlers]]
id = "github-issue"
title = "Open GitHub issue"
pattern = "^https://github\\.com/[^/]+/[^/]+/(issues|pull)/[0-9]+$"
action = "apply"
```

**Required fields:** `id`, `name`, `version`, `min_herdr_version`. `description` is optional.
**Minimum version:** Set `min_herdr_version` to the oldest herdr that supports the APIs, event names, and manifest fields you use. Herdr refuses to link or install a plugin whose minimum is newer than the running binary. Do not raise it to match the herdr you happen to build on.
**ID rules:** A plugin id uses ASCII letters, digits, dot, colon, underscore, and hyphen. An action, pane, or link-handler id uses the same characters, but no dots. Each id type must be unique inside a plugin.
**Platforms:** The top-level field applies to all platforms. An item-level field overrides it. A local plugin with no top-level `platforms` links with a warning.
**Commands:** Commands are argv arrays. Herdr does NOT shell-expand them. They run with the plugin directory as their working directory.

## Startup Hooks

`[[startup]]` commands run once per enabled plugin after herdr restores the session and its API socket is ready. They run again when a new server takes over during live handoff. They do not run when a client attaches, when config reloads, or when a plugin is linked or enabled.

Write a startup hook as one-shot initialization, not a supervised daemon. Restore plugin-owned state, call the APIs you need, then exit. A startup failure does not stop the server.

## Runtime Environment Variables

Injected into all runtime commands:
- `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_ENV=1`
- `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`
- `HERDR_PLUGIN_CONTEXT_JSON` (workspace, tab, focused pane, worktree, agent, selected text, clicked URL, link handler fields when available)
- `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` (when available)

Action-specific: `HERDR_PLUGIN_ACTION_ID`
Startup and event: `HERDR_PLUGIN_EVENT` (`startup` for a startup hook)
Event-specific: `HERDR_PLUGIN_EVENT_JSON`
Pane-specific: `HERDR_PLUGIN_ENTRYPOINT_ID`
Link handler: `HERDR_PLUGIN_CLICKED_URL`, `HERDR_PLUGIN_LINK_HANDLER_ID`, `invocation_source = "link_click"`

## Storage Rules
- **Config** (`.env`, user-editable): `HERDR_PLUGIN_CONFIG_DIR`
- **Runtime state**: `HERDR_PLUGIN_STATE_DIR`
- **NOT in `HERDR_PLUGIN_ROOT`.** GitHub-installed roots are managed checkouts.

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

# Override placement with a session-modal popup (cells or percentages)
herdr plugin pane open --plugin example.layout --entrypoint board \
  --placement popup --width '80%' --height '80%'

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
# Install from GitHub (shorthand only, no URLs)
herdr plugin install owner/repo[/subdir...] [--ref REF] [--yes]

# Remove a GitHub install, managed checkout included
herdr plugin uninstall <plugin-id|owner/repo[/subdir...]>
```

**Marketplace listing:** Add the GitHub topic `herdr-plugin` to a public repository. Put one or more `herdr-plugin.toml` manifests on its default branch, at the root or in subdirectories. The index shows one card per repository and lists each valid manifest as a separately installable plugin, recording its `name`, `version`, `platforms`, `min_herdr_version`, and the exact default-branch commit. It refreshes every 30 minutes and rescans a repository when its default-branch head changes. It excludes forks, archived repositories, and manifests whose required metadata does not parse.

## Pitfalls
- A plugin's build, startup, and runtime commands run as your user with your environment. Read the manifest before you install or link one.
- `command` is argv, not shell. It supports no `$VAR` expansion, no pipes, and no `&&`.
- Relative command paths resolve from the plugin root.
- Build commands do not receive the runtime env or socket.
- `plugin link` does NOT run build commands. Build the plugin yourself.
- Herdr v1 has no `plugin update` command. Reinstall from GitHub to refresh it.
- Plugin ids can contain dots. Action ids cannot. Use the qualified form `plugin.id.action` for global uniqueness.
- `HERDR_PLUGIN_ROOT` is a managed checkout for GitHub installs. Never store user data there.
- On Windows, herdr resolves `PATHEXT` shims (`.cmd`) automatically for build, action, and event commands.
- Popup placement does not create a Herdr pane. It has no `HERDR_PANE_ID`, no pane or agent API target, and no tiled-layout change. Custom-command popups can use `HERDR_ACTIVE_PANE_ID` for the underlying tiled pane.
