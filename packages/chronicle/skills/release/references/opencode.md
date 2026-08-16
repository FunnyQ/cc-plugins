# Release under the OpenCode harness

Release is **flat**: the main skill spawns the leaf agents Skirnir and Annalist
directly. It only ever spawns one level, so unlike commit, PR, and ADR it does
**not** need `subagent_depth >= 2`.

## Agent names are bare

OpenCode agents carry no `chronicle:` prefix:

```text
subagent_type: "skirnir"
subagent_type: "annalist"
```

## Nothing is inherited

OpenCode task-tool subagents do **not** inherit parent context. Pass every
command-specific parameter explicitly on each spawn, plus `$SKILL_DIR` as a
literal:

```text
$SKILL_DIR = ~/.config/opencode/skills/release
```

`CLAUDE_PLUGIN_ROOT` is empty and there is no skill base-directory banner, so
that path has to be stated rather than resolved.

The release-subject exemption in the branch guard applies here in the same way
as under Claude Code.
