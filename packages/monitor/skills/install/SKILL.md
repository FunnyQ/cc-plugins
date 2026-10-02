---
name: install
description: >-
  Check monitor plugin prerequisites and pre-approve its scripts in
  ~/.claude/settings.json.
when_to_use: >-
  Setting up or repairing the monitor plugin (dashboard + cockpit
  prerequisites, script permissions). Also cleans up a stale cockpit-channel
  entry from older versions. Command-triggered only.
---

# monitor install

A guided setup for the whole `monitor` plugin. It is the canonical home for
the plugin's prerequisite checks and config wiring.

`setup.ts` is the single entry point. Its `--check` covers **both** skills:
dashboard data sources and committed assets, the cockpit channel
prerequisites, and the Claude Code version. Its `--apply` writes the
`permissions.allow` entries the plugin's scripts need. It backs up the
original file. It merges the change idempotently and preserves existing keys.

Live usage limits need no wiring. The monitor mod's `session.measure` hook
feeds them to the dashboard on Claude Code.

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

1. **stale-channel cleanup** → removes a leftover hand-wired `cockpit-channel` from `~/.claude.json` if present
2. **plugin script permissions** → adds `Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts[ *])` to `permissions.allow` in `~/.claude/settings.json`, so the marketplace's own scripts run without a permission prompt. A background agent cannot surface a prompt, so an un-allowlisted `bun` call there is silently denied and the flow stalls.

## OpenCode only — skip on Claude Code and Codex

This skill does not apply. The OpenCode layer is installed by the repo's own installer — run `bun opencode/install.ts
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

Never write to `~/.claude.json` or `~/.claude/settings.json` with Edit/Write
directly. Always go through `setup.ts` instead. It handles backup,
idempotency, and existing-key preservation.

### 3. Apply

```bash
# permissions + stale-channel cleanup
bun "${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup.ts" --apply
# preview only, writes nothing
bun "${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup.ts" --dry-run
```

### 4. Tell the user what's next

- The channel needs **Claude Code 2.1.80+**. It is still behind a
  research-preview dev flag. The check reports the installed version.
- The channel is plugin-packaged, so it auto-loads when the plugin is
  enabled. But it only **pushes messages** into sessions launched with the
  dev flag. It can't retro-attach to a session already running. Launch an
  opted-in session with:

  ```bash
  claude --dangerously-load-development-channels plugin:monitor@q-lab-marketplace
  ```

  (This passes `--dangerously-load-development-channels plugin:monitor@q-lab-marketplace`.
  GA-day change: swap the dev flag for `--channels`.)

## Automatic maintenance (SessionStart hook)

A `SessionStart` hook runs `setup.ts --session-check`. Once per plugin
version it removes a stale hand-wired `cockpit-channel` entry. It also
unwraps a `statusLine.command` that still runs the retired collector
(`cockpit atlas statusline`, or the older `statusline-collector.ts`). The
collector goes back to the command it forwarded to: the wrapped
`TOKEN_ATLAS_STATUSLINE_COMMAND='…'` value, or `bunx -y ccstatusline@latest`.
It never adds a statusline you did not have. On every session it checks for
drift — a stale channel entry, missing `permissions.allow` patterns, or an
unparseable `settings.json` — and reports each new finding once, asking the
user to run `/monitor:install`. `setup.ts --migrate` does the once-per-version
work now, with no version gate.

## Notes

- The engine is idempotent. If the permissions are already present and no
  stale channel entry remains, re-running `--apply` writes nothing.
- Backups: every write uses `<file>.bak-<timestamp>`.
- This skill only handles config wiring. It does **not** install bun itself.
  The engine runs on bun, so a missing bun is reported as a required failure
  with the https://bun.sh hint.
