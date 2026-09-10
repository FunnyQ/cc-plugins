# ADR under the OpenCode harness

The topology is the same three-phase nested flow as under Claude Code: spawn
ONE Lorekeeper per phase. The Lorekeeper spawns `gleaner` and `reckoner` for
`collect`, `codifier` for `draft`, and `barrowkeeper` for `commit`. Between
`collect` and gate 1, the **main agent** — not the Lorekeeper — fans the
reckoner's shortlist out to parallel `judge` batches directly. Only the
three items below differ.

## Agent names are bare

OpenCode agents carry no `chronicle:` prefix:

```text
subagent_type: "lorekeeper"
```

The child names are likewise bare: `gleaner`, `reckoner`, `codifier`,
`barrowkeeper`. `judge` is bare too, and — unlike the others — the main agent
spawns it directly, never through the Lorekeeper.

## Nothing is inherited

OpenCode task-tool subagents do **not** inherit parent context. On **every**
Lorekeeper spawn, pass all resolved literal script paths, `contextBrief`, and
the phase-specific carry-over state explicitly, plus the **skill directory** as a literal:

```text
skill directory = /Users/<you>/.config/opencode/skills/adr
```

`CLAUDE_PLUGIN_ROOT` is empty and there is no skill base-directory banner, so
that path has to be stated rather than resolved. The carry-over matters most
here: the phases run as separate spawns around human gates, so state that a
Claude Code run would inherit has to be re-stated each time. The same applies
to every `judge` batch the main agent spawns: each one needs `bodyFetchPath`,
`adrIndex`, and the skill directory restated, exactly like a Lorekeeper spawn.

## Spawn depth

This skill is nested, not flat, so it requires `subagent_depth >= 2` in
`~/.config/opencode/opencode.json`. A fresh OpenCode install ships `1`;
`opencode/install.ts --apply` raises it. Below the required depth the
orchestrator simply stops, with no error naming the config — the failure reads
as a plugin bug.
