---
name: install
description: >-
  Check monitor plugin prerequisites and wire the usage-dashboard statusline
  collector in ~/.claude/settings.json.
when_to_use: >-
  Setting up or repairing the monitor plugin (dashboard + cockpit
  prerequisites, statusline wiring). Also cleans up a stale cockpit-channel
  entry from older versions. Command-triggered only.
---

# monitor install

A guided setup for the whole `monitor` plugin. It is the canonical home for
the plugin's prerequisite checks and config wiring.

`setup.ts` is the single entry point. Its `--check` covers **both** skills:
dashboard data sources and committed assets, the cockpit channel
prerequisites, and the Claude Code version. Its `--apply` wires the one
config a non-developer can't easily edit by hand: the statusline collector.

That edit needs an **absolute path**, because `~/.claude/settings.json` does
not expand `$CLAUDE_PLUGIN_ROOT`. So the engine computes the path itself. It
backs up the original file. It merges the change idempotently and preserves
existing keys.

The **cockpit channel** is packaged in the plugin manifest (`mcpServers` +
`channels` in `.claude-plugin/plugin.json`). Claude Code auto-loads the
channel when the plugin is enabled, so no hand-written `~/.claude.json` entry
is needed. Older versions wired the channel by hand. If such a stale entry is
found, `--apply`/`--migrate` **removes** it, so the channel isn't registered
twice.

What `--check` covers:

- **dashboard** — bun, `~/.claude/stats-cache.json` (run `/stats` once), vendor libs, pricing defaults
- **cockpit** — Claude Code present and ≥ 2.1.80 (channels), the cockpit-channel script, and no stale `~/.claude.json` entry

What `--apply` does:

1. **statusline collector** → `~/.claude/settings.json` (usage-dashboard live usage limits; wraps any existing statusline)
2. **stale-channel cleanup** → removes a leftover hand-wired `cockpit-channel` from `~/.claude.json` if present
3. **plugin script permissions** → adds `Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts[ *])` to `permissions.allow` in `~/.claude/settings.json`. This lets the marketplace's own scripts run without a permission prompt. This matters for nested sub-agents, for example `chronicle:drafter` under `chronicle:editor`: a deeply-nested agent can't surface a permission prompt to be answered. So an un-allowlisted `bun` call is silently denied, and the flow stalls.

The dashboard precheck (`install.ts`) and the statusline wiring
(`setup-statusline.ts`) live in this skill. usage-dashboard imports both, so
there is one source of truth for setup logic.

## OpenCode only — skip on Claude Code and Codex

**The statusline is Claude Code-only.** OpenCode has no statusline equivalent,
and none is planned. Every `${CLAUDE_PLUGIN_ROOT}` statusline instruction below
is a Claude Code instruction — an OpenCode user is not missing a step by
skipping all of them.

**The OpenCode layer is installed by the repo's own installer, not by this
skill.** From a checkout of this repository:

```bash
bun opencode/install.ts --check
bun opencode/install.ts --apply
```

That symlinks the skills into `~/.config/opencode/skills/<name>/` and wires the
rest of the OpenCode layer. This skill keeps owning the Claude Code and Codex
prerequisites exactly as it does today, and writes nothing under
`~/.config/opencode/`.

## Workflow

### 1. Check

Run the read-only check first. Show the user the result:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup.ts"
```

`✓` means already set. `○` means optional, and can be wired. `✗` means a
required prerequisite is missing, for example bun. If a required check
fails, stop. Relay the hint to the user. Do not attempt to apply.

### 2. Ask how to apply

If anything shows `○` (not yet wired / needs cleanup), use
**AskUserQuestion** to let the user choose. Offer these options:

- **Wire it for me (recommended)** — run `setup.ts --apply`. The engine backs
  up any file it touches before writing.
- **Show me the snippet** — run `setup.ts --dry-run`. Paste the output so the
  user edits the files themselves.
- **Just the statusline** — when only the statusline needs wiring (no channel
  cleanup), use `--apply-statusline`.

Never write to `~/.claude.json` or `~/.claude/settings.json` with Edit/Write
directly. Always go through `setup.ts` instead. It handles backup,
idempotency, and existing-key preservation.

### 3. Apply

```bash
# statusline + stale-channel cleanup
bun "${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup.ts" --apply
# preview only, writes nothing
bun "${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup.ts" --dry-run
# statusline only (skips channel cleanup)
bun "${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup.ts" --apply-statusline
```

### 4. Tell the user what's next

- The channel needs **Claude Code 2.1.80+**. It is still behind a
  research-preview dev flag. The check reports the installed version.
- The channel is plugin-packaged, so it auto-loads when the plugin is
  enabled. But it only **pushes messages** into sessions launched with the
  dev flag. It can't retro-attach to a session already running. Launch an
  opted-in session with:

  ```bash
  bun "${CLAUDE_PLUGIN_ROOT}/skills/cockpit/scripts/monitor-up.ts"
  ```

  (This passes `--dangerously-load-development-channels plugin:monitor@q-lab-marketplace`.
  GA-day change: swap the dev flag for `--channels`.)

- Claude Code picks up a statusline change on its next render.

## Automatic maintenance (SessionStart hook)

The plugin ships a `SessionStart` hook, declared in
`.claude-plugin/plugin.json` with matcher `startup`. The hook runs
`setup.ts --session-check`. It is **marker-gated** via
`$CLAUDE_PLUGIN_DATA/.wired-version`, so it acts at most once per plugin
version:

- **Statusline drift** — if an *already-wired* statusline points at an older
  plugin-cache version (for example `.../monitor/3.1.0/...` after an
  update), the hook silently **re-points** it to the current path (backed up
  first). Installed plugins keep old cache dirs, so a path can resolve yet
  still be stale. The check compares the exact current path, not mere
  existence.
- **Stale channel entry** — the hook silently **removes** a leftover
  hand-wired `cockpit-channel` in `~/.claude.json` (backed up first). This
  entry is left over from versions before the channel was plugin-packaged.
  Removing it keeps the packaged channel from being registered twice.
- **Fresh install** — if the statusline isn't wired yet, the hook prints a
  single write-free nudge to run `/monitor:install`. The marker keeps the
  nudge from repeating.
- **Never fresh-wires** — initial statusline opt-in, the first `--apply`,
  always stays manual. The hook only re-points or cleans up state the user
  already has.

Manual equivalents: `setup.ts --migrate` re-points drift and cleans up the
stale channel now, with no version gate. `setup.ts --session-check` is
marker-gated; it is a no-op when `$CLAUDE_PLUGIN_DATA` is unset, so it's safe
to run by hand.

## Notes

- The engine is idempotent. If the statusline is already wired and no stale
  channel entry remains, re-running `--apply` reports "nothing to do" and
  writes nothing.
- "Wired" means the configured path equals the **current** live path. An
  older version's path counts as not-wired, and the hook re-points it.
- Backups: any `~/.claude.json` write uses `<file>.bak-<timestamp>`. The
  statusline write keeps the dashboard's existing `settings.json.bak`
  convention.
- This skill only handles config wiring. It does **not** install bun itself.
  The engine runs on bun, so a missing bun is reported as a required failure
  with the https://bun.sh hint.
