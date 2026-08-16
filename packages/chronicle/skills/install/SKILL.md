---
name: install
description: >-
  Set up Chronicle's prerequisites — the nested-subagent spawn depth on Claude
  Code, and the named agent roles on Codex.
when_to_use: >-
  Setting up or repairing Chronicle. On Claude Code: when commit/pr/release fail
  with "Agent exists but is not enabled in this context". On Codex: registering or
  refreshing the commit/PR/ADR agents (chronicle_lawspeaker,
  chronicle_storykeeper, chronicle_lorekeeper, etc.).
  Not monitor:install (that wires the usage-dashboard statusline).
---

# Chronicle install

## Claude Code — nested subagent spawn depth

Chronicle's commit, PR, and ADR flows are orchestrator-shaped: `main → lawspeaker →
watcher/runesmith`, and the same for `storykeeper` and `lorekeeper`. Claude Code
**2.1.217** stopped letting subagents spawn nested subagents by default. Those
orchestrators then fail with `Agent exists but is not enabled in this context`. No
commit lands, and nothing is staged. (`release` is flat — it spawns leaf agents
directly and does not need this.)

`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` re-enables it. Chronicle needs `2`.

A `SessionStart` hook runs this automatically and writes the setting when it is
missing or too low. A fresh install self-heals this way. Run it by hand to check
or repair:

```bash
bun "$SKILL_DIR/scripts/setup-spawn-depth.ts"            # report only (default)
bun "$SKILL_DIR/scripts/setup-spawn-depth.ts" --dry-run  # show the resulting file
bun "$SKILL_DIR/scripts/setup-spawn-depth.ts" --apply    # write it
```

It only ever **raises** the value. A larger depth set by the user or another
plugin is left alone. It also preserves unrelated settings, and it backs up the
file as `settings.json.bak-chronicle` before a changed write.

⚠️ **The env var is read at session start.** A session that triggers the write
still runs without it. Chronicle's flows keep failing until Claude Code
restarts. Always say this when you report the fix.

## Codex — named agent roles

Register the Codex-native commit roles (`chronicle_lawspeaker`,
`chronicle_watcher`, `chronicle_runesmith`) and PR roles
(`chronicle_storykeeper`, `chronicle_skald`, `chronicle_messenger`), the release
roles (`chronicle_skirnir`, `chronicle_annalist`), plus the ADR roles
(`chronicle_lorekeeper`, `chronicle_gleaner`, `chronicle_reckoner`,
`chronicle_codifier`, `chronicle_barrowkeeper`).

Resolve the plugin root from this skill's load-time base directory. The root is
two directories above this `skills/install` directory. Never point Codex config
at the versioned plugin cache. The setup script copies role TOMLs into the stable
`$CODEX_HOME/agents/chronicle/` directory. It also owns one marked block in
`$CODEX_HOME/config.toml`.

Preview first:

```bash
bun "$SKILL_DIR/scripts/setup-codex-agents.ts" --plugin-root "$PLUGIN_ROOT" --dry-run
```

After explicit user approval, apply:

```bash
bun "$SKILL_DIR/scripts/setup-codex-agents.ts" --plugin-root "$PLUGIN_ROOT" --apply
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

This depth setting is mandatory for Chronicle's nested commit, PR, and ADR skills
to work. Below the required depth the orchestrator simply stops with no error
naming the config. Release is flat, spawns only one level, and does not need the
depth setting.
