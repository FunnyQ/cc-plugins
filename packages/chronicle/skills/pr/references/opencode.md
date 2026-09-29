# PR/MR under the OpenCode harness

The topology is the same as the Claude Code flow: spawn ONE Storykeeper, which
runs the scripts itself and spawns nothing. Only the two items below differ.

## Agent names are bare

OpenCode agents carry no `chronicle:` prefix:

```text
subagent_type: "storykeeper"
```

## Nothing is inherited

OpenCode task-tool subagents do **not** inherit parent context. Pass every
input explicitly on the spawn — `contextBrief`, `base`, `branch`, `draft`, and
`skipReview` — plus the **skill directory** as a literal:

```text
skill directory = /Users/<you>/.config/opencode/skills/pr
```

`CLAUDE_PLUGIN_ROOT` is empty and there is no skill base-directory banner, so
that path has to be stated rather than resolved. State it **tilde-free** — the
Storykeeper quotes it, and `~` does not expand inside quotes. Expand `$HOME`
yourself and pass the result.

