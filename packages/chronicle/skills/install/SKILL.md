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

Chronicle's flows are orchestrator-shaped: `main → lawspeaker → watcher/runesmith`
(and the same for `storykeeper` / `lorekeeper`). Claude Code **2.1.217** stopped
letting subagents spawn nested subagents by default. Those orchestrators then fail
with `Agent exists but is not enabled in this context`. No commit lands, and
nothing is staged.

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
(`chronicle_storykeeper`, `chronicle_skald`, `chronicle_messenger`), plus the
the release role (`chronicle_annalist`), plus the ADR roles
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
