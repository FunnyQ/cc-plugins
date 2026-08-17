# PR/MR under the OpenCode harness

The topology is the same as the Claude Code flow: spawn ONE Storykeeper; the
Storykeeper spawns the skald and messenger children. Only the three items below
differ.

## Agent names are bare

OpenCode agents carry no `chronicle:` prefix:

```text
subagent_type: "storykeeper"
```

The Storykeeper uses the bare child names `skald` and `messenger`.

## Nothing is inherited

OpenCode task-tool subagents do **not** inherit parent context. Pass every
input explicitly on the spawn — `contextBrief`, `base`, `branch`, and `draft` —
plus the **skill directory** as a literal:

```text
skill directory = /Users/<you>/.config/opencode/skills/pr
```

`CLAUDE_PLUGIN_ROOT` is empty and there is no skill base-directory banner, so
that path has to be stated rather than resolved. State it **tilde-free** — the
children quote it, and `~` does not expand inside quotes. Expand `$HOME` yourself
and pass the result.

## Spawn depth

This skill is nested, not flat, so it requires `subagent_depth >= 2` in
`~/.config/opencode/opencode.json`. A fresh OpenCode install ships `1`;
`opencode/install.ts --apply` raises it. Below the required depth the
orchestrator simply stops, with no error naming the config — the failure reads
as a plugin bug.
