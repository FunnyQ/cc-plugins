---
name: install
description: >-
  Set up Chronicle's prerequisites — the nested-subagent spawn depth on Claude
  Code, and the named agent roles on Codex.
when_to_use: >-
  Setting up or repairing Chronicle. On Claude Code: when commit/pr/release fail
  with "Agent exists but is not enabled in this context". On Codex: registering or
  refreshing the commit/PR/release agents (chronicle_lawspeaker,
  chronicle_storykeeper, chronicle_oathkeeper, etc.).
  Not monitor:install (that wires the usage-dashboard statusline).
---

# Chronicle install

## Claude Code — nested subagent spawn depth

Chronicle's flows are orchestrator-shaped: `main → lawspeaker → watcher/runesmith`
(and the same for `storykeeper` / `oathkeeper`). Claude Code **2.1.217** stopped
letting subagents spawn nested subagents by default, so those orchestrators fail
with `Agent exists but is not enabled in this context` — no commit, nothing staged.

`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` re-enables it. Chronicle needs `2`.

A `SessionStart` hook runs this automatically and writes the setting when it is
missing or too low, so a fresh install self-heals. Run it by hand to check or repair:

```bash
bun "$SKILL_DIR/scripts/setup-spawn-depth.ts"            # report only (default)
bun "$SKILL_DIR/scripts/setup-spawn-depth.ts" --dry-run  # show the resulting file
bun "$SKILL_DIR/scripts/setup-spawn-depth.ts" --apply    # write it
```

It only ever **raises** the value — a larger depth set by the user or another
plugin is left alone — preserves unrelated settings, and backs the file up as
`settings.json.bak-chronicle` before a changed write.

⚠️ **The env var is read at session start.** A session that triggers the write is
still running without it, so Chronicle's flows keep failing until Claude Code is
restarted. Always say this when reporting the fix.

## Codex — named agent roles

Register the Codex-native commit roles (`chronicle_lawspeaker`,
`chronicle_watcher`, `chronicle_runesmith`) and PR roles
(`chronicle_storykeeper`, `chronicle_skald`, `chronicle_messenger`), plus the
release roles (`chronicle_seer`, `chronicle_oathkeeper`, `chronicle_smith`,
`chronicle_annalist`, `chronicle_hammerbearer`).

Resolve the plugin root from this skill's load-time base directory: the root is
two directories above this `skills/install` directory. Never point Codex config
at the versioned plugin cache. The setup script copies role TOMLs into the stable
`$CODEX_HOME/agents/chronicle/` directory and owns one marked block in
`$CODEX_HOME/config.toml`.

Preview first:

```bash
bun "$SKILL_DIR/scripts/setup-codex-agents.ts" --plugin-root "$PLUGIN_ROOT" --dry-run
```

After explicit user approval, apply:

```bash
bun "$SKILL_DIR/scripts/setup-codex-agents.ts" --plugin-root "$PLUGIN_ROOT" --apply
```

The script is idempotent, preserves unrelated config, and backs up an existing
config as `config.toml.bak-chronicle` before a changed write. Tell the user to
start a new Codex thread after applying so the role registry reloads.
