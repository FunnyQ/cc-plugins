# Commit under the OpenCode harness

The topology is the same as the Claude Code flow: spawn ONE Lawspeaker; the
Lawspeaker spawns the watcher and runesmith children. Only the three items
below differ.

## Agent names are bare

OpenCode agents carry no `chronicle:` prefix:

```text
subagent_type: "lawspeaker"
```

The Lawspeaker uses the bare child names `watcher` and `runesmith`.

## Nothing is inherited

OpenCode task-tool subagents do **not** inherit parent context. Pass
`contextBrief`, `branch`, and `mode` explicitly on the spawn, exactly as in the
Claude Code flow, plus the **skill directory** as a literal:

```text
skill directory = /Users/<you>/.config/opencode/skills/commit
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
