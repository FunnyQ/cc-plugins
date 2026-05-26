---
name: install
description: >-
  Check monitor prerequisites and wire its two configs — the cockpit-channel
  MCP server in ~/.claude.json and the usage-dashboard statusline collector in
  ~/.claude/settings.json. Command-triggered only.
---

# monitor install

A guided setup for the whole `monitor` plugin — the canonical home for its
prerequisite checks and config wiring. `setup.ts` is the single entry: its
`--check` covers **both** skills (dashboard data sources + committed assets, the
cockpit channel, and Claude Code version), and its `--apply` wires the two
configs a non-developer can't easily edit by hand. Both edits need **absolute
paths**, and `~/.claude.json` does not expand `$CLAUDE_PLUGIN_ROOT`, so the path
can't be templated — the engine computes them, backs up the originals, and
merges idempotently while preserving existing keys.

What `--check` covers:

- **dashboard** — bun, `~/.claude/stats-cache.json` (run `/stats` once), vendor libs, pricing defaults
- **cockpit** — Claude Code present and ≥ 2.1.80 (channels), the cockpit-channel script

What `--apply` wires:

1. **cockpit-channel MCP** → `~/.claude.json` `mcpServers` (the Decision Log send box)
2. **statusline collector** → `~/.claude/settings.json` (usage-dashboard live usage limits; wraps any existing statusline)

The dashboard precheck (`install.ts`) and statusline wiring
(`setup-statusline.ts`) live in this skill and are imported by usage-dashboard,
so there is one source of truth for setup logic.

## Workflow

### 1. Check

Always run the read-only check first and show the user the result:

```bash
bun "$CLAUDE_PLUGIN_ROOT/skills/install/scripts/setup.ts"
```

`✓` already set, `○` optional/can be wired, `✗` a required prerequisite is
missing (e.g. bun). If a required check fails, stop and relay the hint — don't
attempt to apply.

### 2. Ask how to apply

If anything shows `○` (not yet wired), use **AskUserQuestion** to let the user
choose. Offer these options:

- **Wire it for me (recommended)** — run `setup.ts --apply`; the engine backs up
  both files before writing.
- **Show me the snippet** — run `setup.ts --dry-run` and paste the output so the
  user edits the files themselves.
- **Just the channel** / **Just the statusline** — when only one piece is needed,
  use `--apply-channel` or `--apply-statusline`.

Never write to `~/.claude.json` or `~/.claude/settings.json` with Edit/Write
directly — always go through `setup.ts`, which handles backup, idempotency, and
existing-key preservation.

### 3. Apply

```bash
# both pieces
bun "$CLAUDE_PLUGIN_ROOT/skills/install/scripts/setup.ts" --apply
# preview only, writes nothing
bun "$CLAUDE_PLUGIN_ROOT/skills/install/scripts/setup.ts" --dry-run
# one piece at a time
bun "$CLAUDE_PLUGIN_ROOT/skills/install/scripts/setup.ts" --apply-channel
bun "$CLAUDE_PLUGIN_ROOT/skills/install/scripts/setup.ts" --apply-statusline
```

### 4. Tell the user what's next

- The channel needs **Claude Code 2.1.80+** and is behind a research-preview dev
  flag. The check reports the installed version.
- MCP changes in `~/.claude.json` take effect in a **new** session. The channel
  only attaches to sessions launched with the dev flag — it can't retro-attach.
  Launch one with:

  ```bash
  bun "$CLAUDE_PLUGIN_ROOT/skills/cockpit/scripts/monitor-up.ts"
  ```

- A statusline change is picked up on the next Claude Code render.

## Automatic maintenance (SessionStart hook)

The plugin ships a `SessionStart` hook (declared in `.claude-plugin/plugin.json`,
matcher `startup`) that runs `setup.ts --session-check`. It is **marker-gated**
via `$CLAUDE_PLUGIN_DATA/.wired-version`, so it acts at most once per plugin
version:

- **Drift** — if an *already-wired* statusline/channel points at an older
  plugin-cache version (e.g. `.../monitor/3.1.0/...` after an update), it is
  silently **re-pointed** to the current path (backed up first). Installed
  plugins keep old cache dirs, so a path can resolve yet still be stale — the
  check compares the exact current path, not mere existence.
- **Fresh install** — if nothing is wired yet, it prints a single write-free
  nudge to run `/monitor:install`. The marker keeps it from repeating.
- **Never fresh-wires** — initial opt-in (the first `--apply`) always stays
  manual; the hook only re-points pieces the user already chose to wire.

Manual equivalents: `setup.ts --migrate` (re-point drift now, no version gate),
`setup.ts --session-check` (marker-gated; a no-op when `$CLAUDE_PLUGIN_DATA` is
unset, so it's safe to run by hand).

## Notes

- The engine is idempotent: re-running `--apply` when a piece is already wired
  reports "nothing to do" and writes nothing.
- "Wired" means the configured path equals the **current** live path; an older
  version's path counts as not-wired and gets re-pointed.
- Backups: channel/`--apply` writes use `<file>.bak-<timestamp>`; the statusline
  write keeps the dashboard's existing `settings.json.bak` convention.
- This skill only handles config wiring. It does **not** install bun itself
  (the engine runs on bun, so a missing bun is reported as a required failure
  with the https://bun.sh hint).
