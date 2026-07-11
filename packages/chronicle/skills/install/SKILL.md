---
name: install
description: >-
  Register Chronicle's Codex named agents in config.toml. Use when the user asks
  to install, enable, wire, or refresh Chronicle agents for Codex.
---

# Chronicle install

Register the Codex-native commit trio: `chronicle_lawspeaker`,
`chronicle_watcher`, and `chronicle_runesmith`.

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
