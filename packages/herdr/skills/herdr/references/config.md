# Herdr Configuration Reference

This document is verified against herdr 0.8.2. If live CLI output disagrees with this doc, trust `herdr --default-config`.

Config path: `~/.config/herdr/config.toml`

```bash
# Print full default config
herdr --default-config

# Save as starting point
herdr --default-config > ~/.config/herdr/config.toml

# Reload running server after edits
herdr server reload-config
```

## Key Sections

### Onboarding
```toml
onboarding = false  # skip first-run setup
```

### Updates
```toml
[update]
channel = "stable"     # or "preview"
version_check = true   # background version checks
manifest_check = true  # background agent-detection manifest checks
```

### Terminal Defaults
```toml
[terminal]
default_shell = "nu"       # executable name/path; fallback: $SHELL → /bin/sh
shell_mode = "auto"        # "auto" | "login" | "non_login"
new_cwd = "follow"         # "follow" | "home" | "current" | "~/Projects"
```

### Headless Server
```toml
[server]
headless_cols = 120  # virtual terminal size when no client is attached
headless_rows = 40
```

Attached clients always use their own terminal size. Set these when a detached `herdr server` spawns panes for agents that never get a client.

### Worktrees
```toml
[worktrees]
directory = "~/.herdr/worktrees"  # checkouts under <dir>/<repo>/<branch-slug>
```

### Remote Attach
```toml
[remote]
manage_ssh_config = true  # temporary SSH config with keepalive fallback
```

### Keybindings
```toml
[keys]
prefix = "ctrl+b"
goto = "prefix+g"
new_tab = "prefix+c"
next_tab = "prefix+n"
previous_tab = "prefix+p"
move_tab_previous = "alt+shift+left"   # unset by default; reorders the active tab, wrapping at either end
move_tab_next = "alt+shift+right"      # unset by default
focus_pane_left = "prefix+h"
navigate_workspace_down = "j"
navigate_pane_down = "j"
split_horizontal = "prefix+minus"
resize_mode = "prefix+r"
resize_pane_left = "ctrl+shift+alt+left"   # unset by default; resizes without entering resize mode
resize_pane_down = "ctrl+shift+alt+down"   # also resize_pane_up, resize_pane_right
# Indexed: switch_tab = "prefix+1..9"
```

Key syntax examples: `prefix+n`, `ctrl+a`, `shift+n`, `alt+1`, `cmd+k`. Special keys include `enter`, `tab`, `esc`, and `left`. Named punctuation includes `minus`, `comma`, `plus`, and `backtick`.

Custom command keybindings:
```toml
[[keys.command]]
key = "prefix+alt+g"
type = "popup"             # "popup" | "pane" | "shell" | "plugin_action"
command = "lazygit"
description = "run lazygit"
width = "80%"              # terminal cells or percentage; popup only
height = "80%"
```

`popup` opens a session-modal terminal without changing the tab layout. It receives all input, including Escape, until the command exits. Omit `width`/`height` for half-size defaults. Popup commands receive `HERDR_ACTIVE_PANE_ID` for the underlying tiled pane. They do not receive `HERDR_PANE_ID`.

`pane` opens a temporary zoomed pane. `shell` runs detached. `plugin_action` invokes an installed plugin action.

Reset to defaults: `herdr config reset-keys`

### Theme
```toml
[theme]
name = "catppuccin"        # built-in: catppuccin, terminal, tokyo-night, dracula, nord, gruvbox, one-dark, solarized, kanagawa, rose-pine, vesper
auto_switch = true         # follow host terminal light/dark
light_name = "catppuccin-latte"
dark_name = "catppuccin"

[theme.custom]
accent = "#a6e3a1"
panel_bg = "reset"
sidebar_bg = "#181825"     # sidebar background, independent of the base theme
active_row_bg = "#1e1e2e"  # active Space/Agent row
selection_bg = "#313244"   # navigate-mode cursor row
```

Values accept hex (`#rrggbb`), named colors, `rgb(r,g,b)`, or `"reset"`. Run `herdr config check` after editing `name` — it now reports an unknown built-in theme name instead of accepting it silently.

### UI / Sidebar
```toml
[ui]
sidebar_width = 26
sidebar_min_width = 18
sidebar_max_width = 36
sidebar_collapsed_mode = "compact"  # "compact" | "hidden"
mobile_width_threshold = 64
mouse_capture = true
copy_on_select = true
host_cursor = "auto"                # "auto" | "native" | "drawn"
right_click_passthrough_modifier = ""
redraw_on_focus_gained = true
mouse_scroll_lines = 3
confirm_close = true
prompt_new_tab_name = true
pane_borders = true
pane_outer_borders = true               # false drops the outside frame, keeping internal dividers
pane_scrollbars = true
pane_gaps = true
show_agent_labels_on_pane_borders = false
hide_tab_bar_when_single_tab = false
tab_bar_position = "top"                # "top" | "bottom"
tab_bar_right_separator = " "
sidebar_start_collapsed = false
prompt_new_workspace_name = false
agent_panel_sort = "spaces"  # "spaces" | "priority"
status_indicators = "dots"   # "dots" | "symbols" — symbols give blocked/working/done/idle/unknown distinct static shapes
window_title = "{hostname}: {workspace}"  # outer terminal title; "" leaves it alone
accent = "cyan"

# Right-aligned desktop tab-bar status entries, in order.
tab_bar_right = [
  { type = "zoom" },
  { type = "hostname" },
  { type = "datetime", format = "%H:%M" },
  { type = "text", text = "prod" },
  { type = "command", command = "~/.config/herdr/status.sh", interval_seconds = 5, timeout_seconds = 2 },
]

[ui.sidebar.agents]
row_gap = 0
rows = [["state_icon", "workspace", "tab"], ["agent"]]

[ui.sidebar.agents.rows_by_agent]
claude = [["state_icon", "workspace", "tab"], ["terminal_title_stripped"], ["agent"]]

[ui.sidebar.spaces]
row_gap = 0
rows = [["state_icon", "workspace"], ["branch", "git_status"]]
```

Sidebar rows may use built-in tokens or custom `$name` values. Herdr reports these through `pane report-metadata --token` / `workspace report-metadata --token`. An agent-specific entry replaces the default agent rows. It does not extend them.

`window_title` tokens are `{hostname}`, `{workspace}`, `{tab}`, `{pane}`, and `{terminal_title}`; write `{{` and `}}` for literal braces. The title renders on the Herdr server, so `{hostname}` names the machine the panes run on even under `herdr --remote`.

`tab_bar_right` is empty by default. `hostname`, `datetime`, and `command` also resolve on the server. `datetime` takes `strftime` formatting and rejects directives needing a UTC offset or Unix timestamp, such as `%z` and `%s`. A `command` entry runs immediately, then every `interval_seconds`, without overlapping a previous run; Herdr keeps the last line of successful output and clears it on failure, empty output, or `timeout_seconds`.

### Notifications (Toast)
```toml
[ui.toast]
delivery = "off"           # "off" | "herdr" | "terminal" | "system"
delay_seconds = 1

[ui.toast.herdr]
position = "bottom-right"

[ui.toast.clipboard]
enabled = true
position = "bottom-center"
```

### Sound
```toml
[ui.sound]
enabled = true
path = "sounds/notification.mp3"
done_path = "sounds/done.mp3"
request_path = "sounds/request.mp3"

[ui.sound.agents]
droid = "off"
claude = "on"
```

### Session / Restore
```toml
[session]
resume_agents_on_restore = true  # native agent session restore (default on)

[experimental]
pane_history = false             # save pane contents across restarts
allow_nested = false             # herdr inside herdr
kitty_graphics = false
reveal_hidden_cursor_for_cjk_ime = false
cjk_ime_agents = []
cjk_ime_cursor_shape = "steady_block"
switch_ascii_input_source_in_prefix = false  # macOS and Windows
```

### Scrollback
```toml
[advanced]
scrollback_limit_bytes = 10000000  # ~10 MB
```

### Environment Variables
| Variable | Purpose |
|---|---|
| `HERDR_CONFIG_PATH` | Override config file path |
| `HERDR_SESSION` | Select named session |
| `HERDR_SOCKET_PATH` | Low-level socket override |
| `HERDR_LOG` | Log filter (e.g. `herdr=debug`) |
| `HERDR_DISABLE_SOUND` | Disable sound even if enabled in config |
| `HERDR_PROCESS_DETECTION` | Set `child-groups` on Linux runtimes without foreground process groups |
