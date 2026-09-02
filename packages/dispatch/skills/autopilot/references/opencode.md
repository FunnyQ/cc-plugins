# Autopilot under the OpenCode harness

Read this only when the OpenCode agent is the one invoking `/autopilot`. It
replaces the "How orchestration works" section of `SKILL.md`. The rest of that
file — the scout step, the task tree, the rubric gate, escalation — still
applies.

**Two different things share the name "OpenCode" in this skill. This file is
only the first one.** Running autopilot **under** the OpenCode harness is what
this documents. Delegating **out to** the `opencode` CLI
(`CFG.devEngine: 'opencode'`, `CFG.reviewEngine: 'opencode'`,
`opencode-run.ts`, Step 2 and the Model policy table) is a Claude Code flight
that shells out to an external engine. This file changes none of that, and
none of that applies here.

OpenCode exposes no Workflow tool and no equivalent — the primary agent's full
tool list is `bash, edit, glob, grep, read, skill, task, todowrite, webfetch,
write`, and `task` is the only spawn mechanism. Autopilot therefore runs here
as a **hand-driven wave loop over the task tool**.

**Read this before the steps.** The loop below is behaviorally close to the
Claude Code flight but **not identical**: there is **no automatic parallel-wave
scheduling** and **no orchestrator process**. The waves are driven **by hand,
one at a time, by whoever invoked the skill**, who must stay at the keyboard
between waves. Autopilot under OpenCode is not the same unattended flight — do
not report it to the user as one.

## Script root

There is no *"Base directory for this skill"* banner; `CLAUDE_PLUGIN_ROOT` is
empty. Two paths, stated literally:

- `$SCRIPTS` = `~/.config/opencode/skills/flightplan/scripts` — the shared
  tools autopilot borrows: `next-ready.ts`, `lint-task.ts`, `score-task.ts`,
  `mark-done.ts`, `flightlog.ts`.
- `$OWN` = `~/.config/opencode/skills/autopilot/scripts` — autopilot's own,
  `flightdeck.ts`.

The sibling-relative form `<base>/../flightplan/scripts` also resolves, because
each skill is symlinked separately and the two siblings sit beside each other
under both the symlink root and the realpath.

## The wave loop

Repeat these steps by hand, one wave at a time:

1. Run the ready-task lister `bun $SCRIPTS/next-ready.ts <tasks-dir> --summary`
   against the tasks directory to get the current wave. Re-run it every wave —
   a static list misses tasks unblocked mid-flight.
2. For each ready task in the wave, spawn a subagent through the **task tool**
   in the **dev role**, giving it the task file path and the instruction to
   implement that task.
3. Run that task's own `## Verification` commands yourself, and check its
   `## Acceptance criteria`.
4. Spawn a second subagent through the **task tool** in the **judge role**, to
   score the task against its `## Eval rubric`.
5. Write the judge's rationale to a file, then run `bun $SCRIPTS/score-task.ts
   <taskfile> <scores.json> --json --log <run.jsonl> --attempt N --agent <label>
   --rationale-file <rationale.md>` and gate on the printed verdict object. Do
   not re-derive the weighted average or the hard-fail arithmetic by hand —
   there is exactly one scoring implementation. Skip the rationale file and a
   passing task leaves only a number behind in the trail.
6. Retry the task until its rubric passes or the attempt cap is reached. Park a
   capped task at `Status: blocked` and escalate it to the user; never silently
   skip it.
7. Make one atomic commit **between** waves, never inside one — the tasks of a
   wave share a working tree, so a mid-wave commit sweeps a sibling's
   half-finished edits into it.
8. Run the closing `Final review` task last, after every other task is done.

## Subagents

**Both spawns use `subagent_type: general`**, with the dev and judge roles
carried entirely by the inline prompt — `explore` and `general` are the only
built-in subagents. There is no `dev` agent and no `judge` agent in this build,
and none is needed — both roles are leaves that never spawn anything
themselves.

**`general` has no `task` tool and cannot spawn further**, at any
`subagent_depth` — raising the depth does not grant it. That is harmless for
the dev and judge roles, but it means the wave loop's driver must stay the one
doing the spawning. There is no way to delegate the loop itself to a `general`
subagent.

**Spawn depth.** Because the loop spawns through the task tool, the driver
needs `subagent_depth` at or above the installed value of `2` in
`~/.config/opencode/opencode.json`; a fresh install defaults to `1`, which
`opencode/install.ts --apply` raises. Below the required depth a spawn fails
with no error naming the config, so it reads as a plugin bug. This is the
OpenCode counterpart of Claude Code's
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`.
