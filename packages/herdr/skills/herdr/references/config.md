# Herdr Configuration Reference

Verified against herdr 0.7.1; if live CLI output disagrees with this doc, trust `herdr --help` / `herdr --default-config`.

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
focus_pane_left = "prefix+h"
navigate_workspace_down = "j"
navigate_pane_down = "j"
split_horizontal = "prefix+minus"
# Indexed: switch_tab = "prefix+1..9"
```

Key syntax: `prefix+n`, `ctrl+a`, `shift+n`, `alt+1`, `cmd+k`, special keys (`enter`, `tab`, `esc`, `left`…), named punctuation (`minus`, `comma`, `plus`, `backtick`).

Custom command keybindings:
```toml
[[keys.command]]
key = "prefix+alt+g"
type = "pane"              # "pane" | "shell" | "plugin_action"
command = "lazygit"
description = "run lazygit"
```

Reset to defaults: `herdr config reset-keys`

### Theme
```toml
[theme]
name = "catppuccin"        # built-in: catppuccin, tokyo-night, dracula, nord, gruvbox, one-dark, solarized, kanagawa, rose-pine, vesper, terminal…
auto_switch = true         # follow host terminal light/dark
light_name = "catppuccin-latte"
dark_name = "catppuccin"

[theme.custom]
accent = "#a6e3a1"
panel_bg = "reset"
```

### UI / Sidebar
```toml
[ui]
sidebar_width = 32
sidebar_min_width = 18
sidebar_max_width = 36
mobile_width_threshold = 64
mouse_capture = true
confirm_close = true
prompt_new_tab_name = true
pane_borders = true
pane_gaps = true
show_agent_labels_on_pane_borders = false
agent_panel_sort = "spaces"  # "spaces" | "priority"
accent = "cyan"
```

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
switch_ascii_input_source_in_prefix = false  # macOS only
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
