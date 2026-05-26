---
name: install
description: >-
  Check monitor prerequisites and wire the usage-dashboard statusline collector
  in ~/.claude/settings.json. The cockpit channel is plugin-packaged now, so this
  skill only cleans up a stale ~/.claude.json entry from older versions.
  Command-triggered only.
---

# monitor install

A guided setup for the whole `monitor` plugin — the canonical home for its
prerequisite checks and config wiring. `setup.ts` is the single entry: its
`--check` covers **both** skills (dashboard data sources + committed assets, the
cockpit channel prerequisites, and Claude Code version), and its `--apply` wires
the one config a non-developer can't easily edit by hand: the statusline
collector. That edit needs an **absolute path** (`~/.claude/settings.json` does
not expand `$CLAUDE_PLUGIN_ROOT`), so the engine computes it, backs up the
original, and merges idempotently while preserving existing keys.

The **cockpit channel** is packaged in the plugin manifest (`mcpServers` +
`channels` in `.claude-plugin/plugin.json`), so Claude Code auto-loads it when
the plugin is enabled — no hand-written `~/.claude.json` entry is needed. Older
versions wired it by hand; if such a stale entry is found, `--apply`/`--migrate`
**removes** it so the channel isn't registered twice.

What `--check` covers:

- **dashboard** — bun, `~/.claude/stats-cache.json` (run `/stats` once), vendor libs, pricing defaults
- **cockpit** — Claude Code present and ≥ 2.1.80 (channels), the cockpit-channel script, and no stale `~/.claude.json` entry

What `--apply` does:

1. **statusline collector** → `~/.claude/settings.json` (usage-dashboard live usage limits; wraps any existing statusline)
2. **stale-channel cleanup** → removes a leftover hand-wired `cockpit-channel` from `~/.claude.json` if present

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

If anything shows `○` (not yet wired / needs cleanup), use **AskUserQuestion** to
let the user choose. Offer these options:

- **Wire it for me (recommended)** — run `setup.ts --apply`; the engine backs up
  any file it touches before writing.
- **Show me the snippet** — run `setup.ts --dry-run` and paste the output so the
  user edits the files themselves.
- **Just the statusline** — when only the statusline needs wiring (no channel
  cleanup), use `--apply-statusline`.

Never write to `~/.claude.json` or `~/.claude/settings.json` with Edit/Write
directly — always go through `setup.ts`, which handles backup, idempotency, and
existing-key preservation.

### 3. Apply

```bash
# statusline + stale-channel cleanup
bun "$CLAUDE_PLUGIN_ROOT/skills/install/scripts/setup.ts" --apply
# preview only, writes nothing
bun "$CLAUDE_PLUGIN_ROOT/skills/install/scripts/setup.ts" --dry-run
# statusline only (skips channel cleanup)
bun "$CLAUDE_PLUGIN_ROOT/skills/install/scripts/setup.ts" --apply-statusline
```

### 4. Tell the user what's next

- The channel needs **Claude Code 2.1.80+** and is still behind a research-preview
  dev flag. The check reports the installed version.
- The channel is plugin-packaged, so it auto-loads when the plugin is enabled —
  but it only **pushes messages** into sessions launched with the dev flag, and
  it can't retro-attach. Launch an opted-in session with:

  ```bash
  bun "$CLAUDE_PLUGIN_ROOT/skills/cockpit/scripts/monitor-up.ts"
  ```

  (This passes `--dangerously-load-development-channels plugin:monitor@q-lab-marketplace`.
  GA-day change: swap the dev flag for `--channels`.)

- A statusline change is picked up on the next Claude Code render.

## Automatic maintenance (SessionStart hook)

The plugin ships a `SessionStart` hook (declared in `.claude-plugin/plugin.json`,
matcher `startup`) that runs `setup.ts --session-check`. It is **marker-gated**
via `$CLAUDE_PLUGIN_DATA/.wired-version`, so it acts at most once per plugin
version:

- **Statusline drift** — if an *already-wired* statusline points at an older
  plugin-cache version (e.g. `.../monitor/3.1.0/...` after an update), it is
  silently **re-pointed** to the current path (backed up first). Installed
  plugins keep old cache dirs, so a path can resolve yet still be stale — the
  check compares the exact current path, not mere existence.
- **Stale channel entry** — a leftover hand-wired `cockpit-channel` in
  `~/.claude.json` (from versions before the channel was plugin-packaged) is
  silently **removed** (backed up first), so the packaged channel isn't
  registered twice.
- **Fresh install** — if the statusline isn't wired yet, it prints a single
  write-free nudge to run `/monitor:install`. The marker keeps it from repeating.
- **Never fresh-wires** — initial statusline opt-in (the first `--apply`) always
  stays manual; the hook only re-points/cleans up state the user already has.

Manual equivalents: `setup.ts --migrate` (re-point drift + clean up the stale
channel now, no version gate), `setup.ts --session-check` (marker-gated; a no-op
when `$CLAUDE_PLUGIN_DATA` is unset, so it's safe to run by hand).

## Notes

- The engine is idempotent: re-running `--apply` when the statusline is wired and
  no stale channel entry remains reports "nothing to do" and writes nothing.
- "Wired" means the configured path equals the **current** live path; an older
  version's path counts as not-wired and gets re-pointed.
- Backups: any `~/.claude.json` write uses `<file>.bak-<timestamp>`; the statusline
  write keeps the dashboard's existing `settings.json.bak` convention.
- This skill only handles config wiring. It does **not** install bun itself
  (the engine runs on bun, so a missing bun is reported as a required failure
  with the https://bun.sh hint).
