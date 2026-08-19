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

This skill does not apply. The statusline is Claude Code-only, and the OpenCode
layer is installed by the repo's own installer — run `bun opencode/install.ts
--check`, then `--apply`, from a checkout of this repository. This skill writes
nothing under `~/.config/opencode/`.

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
`setup.ts --session-check`, which has two halves with different rules.

### Repair — marker-gated, at most once per version

Gated on `$CLAUDE_PLUGIN_DATA/.wired-version`. An upgrade is the only drift
this hook repairs on its own, because the upgrade is what caused it.

- **Statusline drift** — if an *already-wired* statusline points at an older
  plugin-cache version (for example `.../monitor/3.1.0/...` after an
  update), the hook **re-points** it to the current path (backed up first).
  Installed plugins keep old cache dirs, so a path can resolve yet still be
  stale. The check compares the exact current path, not mere existence.
- **Stale channel entry** — the hook **removes** a leftover hand-wired
  `cockpit-channel` in `~/.claude.json` (backed up first). This entry is left
  over from versions before the channel was plugin-packaged. Removing it keeps
  the packaged channel from being registered twice.
- **Never fresh-wires** — initial statusline opt-in, the first `--apply`,
  always stays manual. The hook only re-points or cleans up state the user
  already has.

### Drift watch — every session, read-only

Config also drifts *within* a version: a hand-edited `settings.json`, a
restored backup, a reinstall under a different cache root. The repair half
never sees any of it, so a second half runs on every session, writes nothing,
and asks the user to fix what it finds. It reports:

- a statusline collector belonging to another install;
- a stale hand-wired `cockpit-channel` in `~/.claude.json`;
- the `q-lab` script patterns missing from `permissions.allow`;
- a `settings.json` that no longer parses (reported alone — nothing past it
  can be read);
- nothing wired at all, as the one fresh-install nudge (it subsumes the rest).

The notice goes out as a `systemMessage` in a **single JSON object on stdout**
— that field is what reaches the user; bare stdout only reaches the model. So
nothing else in `--session-check` may print, and `migrate()`'s own output is
captured rather than echoed.

Repetition is keyed on **which** pieces are off, recorded in
`$CLAUDE_PLUGIN_DATA/.drift-notice`. The same complaint is made once; a drift
that is fixed and later returns is reported again.

Manual equivalents: `setup.ts --migrate` re-points drift and cleans up the
stale channel now, with no version gate. `setup.ts --session-check` is a no-op
when `$CLAUDE_PLUGIN_DATA` is unset, so it's safe to run by hand.

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
