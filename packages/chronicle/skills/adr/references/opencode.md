# ADR under the OpenCode harness

The topology is the same flow as under Claude Code. The **main agent** runs
`triage.ts`, fans its batch files out to parallel `judge` agents, then spawns the
`codifier` after gate 1 and the `barrowkeeper` after gate 2 — all directly. None of
them spawns anything. Only the two items below differ.

## Agent names are bare

OpenCode agents carry no `chronicle:` prefix:

```text
subagent_type: "codifier"
```

`judge` and `barrowkeeper` are bare too.

## Nothing is inherited

OpenCode task-tool subagents do **not** inherit parent context. On **every**
spawn, pass that agent's literal paths (per **Script paths** in SKILL.md) and its
inputs explicitly, plus the **skill directory** as a literal:

```text
skill directory = /Users/<you>/.config/opencode/skills/adr
```

`CLAUDE_PLUGIN_ROOT` is empty and there is no skill base-directory banner, so
that path has to be stated rather than resolved. Each `judge` needs its three
literal paths — `batchPath`, `bodyFetchPath`, and `triagePath` — and nothing else:
the batch file carries the clusters and the record index.
