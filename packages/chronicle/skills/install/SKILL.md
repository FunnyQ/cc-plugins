---
name: install
description: >-
  Set up Chronicle's prerequisites — the named agent roles on Codex.
when_to_use: >-
  Setting up or repairing Chronicle on Codex: registering or refreshing the
  commit/PR/ADR agents (chronicle_lawspeaker,
  chronicle_storykeeper, chronicle_codifier, etc.).
  Not monitor:install (that wires the usage-dashboard statusline).
---

# Chronicle install

## Claude Code — nothing to set up

Claude Code needs no setup. Chronicle's agents register from the plugin, and none of
them spawns a child, so no subagent spawn depth has to be raised.

Chronicle used to need `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` of `2` for its `pr` and
`adr` orchestrators, and a `SessionStart` hook wrote it. Both orchestrators are gone.
A value an earlier version wrote into `~/.claude/settings.json` is harmless: leave it,
or remove it by hand if nothing else needs it.

## Codex — named agent roles

Register the Codex-native commit role (`chronicle_lawspeaker`), PR role
(`chronicle_storykeeper`), release role (`chronicle_annalist`), and ADR roles
(`chronicle_judge`, `chronicle_codifier`, `chronicle_barrowkeeper`).

Resolve the plugin root from this skill's load-time base directory. The root is
two directories above this `skills/install` directory. Never point Codex config
at the versioned plugin cache. The setup script copies role TOMLs into the stable
`$CODEX_HOME/agents/chronicle/` directory. It also owns one marked block in
`$CODEX_HOME/config.toml`.

Preview first:

```bash
bun "{SKILL_DIR}/scripts/setup-codex-agents.ts" --plugin-root "$PLUGIN_ROOT" --dry-run
```

After explicit user approval, apply:

```bash
bun "{SKILL_DIR}/scripts/setup-codex-agents.ts" --plugin-root "$PLUGIN_ROOT" --apply
```

The script is idempotent. It preserves unrelated config, and it backs up an
existing config as `config.toml.bak-chronicle` before a changed write. Tell the
user to start a new Codex thread after applying. This lets the role registry
reload.

## OpenCode installer — skip on Claude Code and Codex

The OpenCode installer is `opencode/install.ts`, run from a checkout of this
repository — not from the installed skill. It supports `--check`,
`--dry-run`, `--apply`, and `--unlink`. On `--apply`, it raises
`subagent_depth` to `2` in `~/.config/opencode/opencode.json`.

Chronicle no longer needs that setting: every chronicle skill is flat. The installer
still raises it for dispatch's `autopilot`, whose OpenCode reference requires it.
