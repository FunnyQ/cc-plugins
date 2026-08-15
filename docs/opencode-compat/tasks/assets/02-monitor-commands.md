# ASSETS-02: Monitor commands in OpenCode format

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/repo-state.md`
> - `../_context/runtime-facts.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: runtime/02
> **Status**: todo

## Goal

Both monitor commands — the scribe-nudge toggle and thoughtful auto-logging — are invocable from an OpenCode session, as new files under `opencode/commands/`, with the Claude Code originals left byte-identical.

## Files to create / modify

- `opencode/commands/nudge.md` (new) — OpenCode port of the scribe-nudge toggle command.
- `opencode/commands/thoughtful.md` (new) — OpenCode port of the thoughtful auto-logging command, with a third harness section added.

Read-only sources (do **not** edit — they are the live Claude Code commands and are on the do-not-touch list):

- `packages/monitor/commands/nudge.md`
- `packages/monitor/commands/thoughtful.md`

## Implementation notes

### The OpenCode command format

A command is a markdown file in `~/.config/opencode/commands/`. The **filename is the command name** — `nudge.md` becomes `/nudge`. Frontmatter recognizes `description` (plus optional `agent` and `model`); unknown keys are ignored but should not be carried over as noise. The body is a prompt template supporting:

- `$ARGUMENTS` — everything the user typed after the command name
- `$1`, `$2`, … — positional arguments
- `` !`some command` `` — shell interpolation, executed and inlined
- `@path/to/file` — file inlining

Both ported files install as symlinks at `~/.config/opencode/commands/<name>.md`.

### The two commands are Claude-bound in different ways

This is the central point of the task. Do not apply one fix to both.

**`nudge` is bound by a path interpolation.** Its bash block interpolates `${CLAUDE_PLUGIN_ROOT}`, which is empty under OpenCode. The fix is mechanical.

**`thoughtful` is bound by a tool contract.** It never mentions `CLAUDE_PLUGIN_ROOT`. Its dependency is the Agent tool's `subagent_type: "fork"`, which has no direct OpenCode equivalent. The fix is a new harness section, not a path swap.

### Converting `nudge`

Keep the `description` value verbatim:

```yaml
---
description: Toggle the scribe Stop-hook auto-log reminders at session / project / user scope.
---
```

**Drop `argument-hint`.** The source carries `argument-hint: "[on|off|toggle|clear|status] [--scope session|project|user]"`; OpenCode does not consume that key. The information is not lost — the Actions and Scopes prose in the body already states every accepted value.

Replace the single bash line. The source reads:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/cockpit/scripts/cockpit.ts nudge $ARGUMENTS
```

The port reads:

```bash
bun ~/.config/opencode/skills/cockpit/scripts/cockpit.ts nudge $ARGUMENTS
```

This is the skill root rule from the shared context applied to the cockpit skill. `$ARGUMENTS` carries over unchanged — OpenCode uses the same token.

Everything else — the opening paragraph, the "Run this exactly" instruction, the **Actions** list, the **Scopes** list, and the most-specific-scope-wins paragraph — copies across unchanged. No behavior in that prose is Claude-specific.

### Converting `thoughtful`

Keep the frontmatter as-is; it carries only `description`, and OpenCode consumes that key:

```yaml
---
description: Enable thoughtful auto-logging for this cockpit session (spawn /cockpit scribe forks)
---
```

**Preserve the existing Claude Code and Codex sections intact.** They are not dead weight in an OpenCode file — the file documents one behavior across harnesses, and a reader on any harness needs to find their own section. Removing the other two would also make the port diverge from its source for no reason.

**Add a third section for OpenCode.** Runtime fact **S9 is resolved: task subagents start clean and inherit nothing.** A parent holding a secret passphrase spawned a subagent and asked for it back; the subagent replied `NO-CONTEXT`.

So the OpenCode section follows the Codex shape, not the Claude one:

- Resolve the parent session id **first**, then embed it literally in the spawn prompt. There is no fork-style inheritance to lean on.
- State in the prompt which harness the child is running under, so its `cockpit scribe` calls carry the right provider flag — exactly as the Codex section passes `--provider codex` and an explicit `<parent-session-id>`.
- Spawn with `subagent_type: general`, the built-in subagent, and do not wait for it.
- Because the child sees none of the conversation, the prompt has to carry enough of the *what* for the distillation to be worth anything. Say so plainly in the section: an OpenCode fork is a briefing, not a handoff.

The section must additionally state: **OpenCode has no SessionStart hook**, the same limitation the Codex section already notes. So invoking the command is the only way to enable this behavior there — nothing turns it on automatically at session start.

Match the voice of the two existing sections: imperative, one instruction per sentence, with the literal spawn prompt in a fenced `text` block.

### Blocking runtime fact

**S9 is resolved — nothing blocks this task.** Subagents start clean, so the OpenCode section takes the explicit-session-id branch described above. Cite the fact in the task report rather than re-deriving it.

The `nudge` conversion never had a runtime-fact dependency. Complete both halves together.

## Acceptance criteria

- [ ] `opencode/commands/nudge.md` and `opencode/commands/thoughtful.md` both exist.
- [ ] Neither new file contains the string `CLAUDE_PLUGIN_ROOT`.
- [ ] `opencode/commands/nudge.md` invokes `bun ~/.config/opencode/skills/cockpit/scripts/cockpit.ts nudge $ARGUMENTS` and uses the `$ARGUMENTS` token.
- [ ] `opencode/commands/nudge.md` frontmatter carries `description` and does **not** carry `argument-hint`.
- [ ] `opencode/commands/thoughtful.md` frontmatter parses and carries `description`.
- [ ] `opencode/commands/thoughtful.md` still contains its Claude Code section and its Codex section, plus a new OpenCode section.
- [ ] The OpenCode section of `opencode/commands/thoughtful.md` states that OpenCode has no SessionStart hook, so the command is the only way to enable the behavior.
- [ ] `git diff --quiet -- packages/monitor/commands/` exits 0 — the two source commands are unchanged.

## Verification

- [ ] Parse the frontmatter of both new files (for example `bun -e` with a YAML-block split, or `head -6` on each) and confirm each yields a non-empty `description`.
- [ ] `grep -c CLAUDE_PLUGIN_ROOT opencode/commands/nudge.md opencode/commands/thoughtful.md` reports 0 for both.
- [ ] `git diff --quiet -- packages/monitor/commands/ && echo UNCHANGED` prints `UNCHANGED`.
- [ ] Sandbox round-trip: with the commands symlinked into a sandboxed `~/.config/opencode/commands/`, run `/nudge status` in an OpenCode session and confirm it prints the effective scope breakdown rather than an error about an unresolved path.
- [ ] Best-effort `/thoughtful` smoke run in an OpenCode session — confirm the agent reads the OpenCode section and attempts a task-subagent spawn. Requires a running cockpit daemon; record it as not-run if the daemon is unavailable rather than claiming a pass.
- [ ] `git status --short -- opencode/commands docs/opencode-compat/tasks/assets/02-monitor-commands.md` shows both paths dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A source file under `packages/monitor/commands/` was modified, or `CLAUDE_PLUGIN_ROOT` survives in a port | Paths converted but `argument-hint` carried over, or a harness section was dropped from the thoughtful port | Both ports match the conversion spec exactly; sources byte-identical; all three harness sections present |
| Runnable instructions | ×2 | The nudge bash line does not resolve to a real script path | Command runs but arguments are not threaded through | `/nudge status` round-trips in a sandbox; the thoughtful spawn prompt is literal and copy-pasteable |
| Section clarity | ×1 | The OpenCode section is interleaved with the Claude one | A reader must compare sections to work out which applies to them | Each harness section is self-contained and findable in one glance |
| Assumptions & docs | ×1 | The S9 branch was guessed with no note | The chosen branch is stated but its source is not | The chosen branch cites the resolved runtime fact, and the no-SessionStart limitation is stated explicitly |

## Out of scope

- Registering the commands in any OpenCode config file — Deferred. Reason: commands ship as files and are discovered by directory scan; the installer symlinks them and writes no command entry anywhere.
- Building the installer target table that places these symlinks — Deferred. Reason: this task produces the two files; wiring them into an install path is separate work tracked in its own bucket.
- Adding an OpenCode auto-enable hook for thoughtful — Deferred. Reason: OpenCode exposes no session-start hook, so there is nothing to attach to; the command stays the only entry point.
