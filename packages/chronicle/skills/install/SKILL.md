---
name: install
description: >-
  [codex only] Register Chronicle's Codex named agents in config.toml.
when_to_use: >-
  Setting up or refreshing Chronicle's commit/PR/release Codex agents
  (chronicle_lawspeaker, chronicle_storykeeper, chronicle_oathkeeper, etc.).
  Not monitor:install (that wires the usage-dashboard statusline).
---

# Chronicle install

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
