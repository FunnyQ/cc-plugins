# Release under the OpenCode harness

Release is **flat**: the main skill runs the scripts itself and spawns the leaf
agent Annalist directly. It only ever spawns one level, so unlike PR and ADR it
does **not** need `subagent_depth >= 2`. Commit is flat too.

## Agent names are bare

OpenCode agents carry no `chronicle:` prefix:

```text
subagent_type: "annalist"
```

## Nothing is inherited

OpenCode task-tool subagents do **not** inherit parent context. Pass every
parameter the entry needs explicitly on the spawn, plus the **skill directory** as a
literal:

```text
skill directory = /Users/<you>/.config/opencode/skills/release
```

`CLAUDE_PLUGIN_ROOT` is empty and there is no skill base-directory banner, so
that path has to be stated rather than resolved — in your own `bun` commands as
much as in the Annalist's prompt. State it **tilde-free**: the child quotes it, and
`~` does not expand inside quotes. Expand `$HOME` yourself and pass the result.

The release-subject exemption in the branch guard applies here in the same way
as under Claude Code.
