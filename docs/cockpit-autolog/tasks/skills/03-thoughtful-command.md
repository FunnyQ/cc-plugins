# SKILLS-03: Thoughtful command + delete the thoughtful skill

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: skills/01, skills/02
> **Blocks**: skills/04, docs/01
> **Status**: done

## Goal

Turn `thoughtful` from a skill into a slash command that injects the standing auto-log
instruction, and delete the old `thoughtful` skill.

## Files to create / modify

- `packages/monitor/commands/thoughtful.md` (new) — the command.
- `packages/monitor/skills/thoughtful/` (delete) — entire directory (use `trash`).

## Implementation notes

### Command file shape

`packages/monitor` has no `commands/` dir yet — create it; plugin manifests auto-discover a
top-level `commands/` directory. A slash-command file is YAML frontmatter + a Markdown body
that becomes the injected prompt. Use exactly this frontmatter (no `$ARGUMENTS` — this is a
toggle, not an argument-taking command):

```markdown
---
description: Enable thoughtful auto-logging for this cockpit session (spawn /cockpit scribe forks)
---

<body — the standing instruction below>
```

`description` is the only required field. Do not add `allowed-tools`/`model`/`argument-hint`
unless needed. Keep the body self-contained (both Claude + Codex paths inlined).

### Body = the standing instruction

Port the substance of the current `thoughtful` skill into the command body. It is a
**standing instruction to the main agent**, not a worker:

- When you complete something genuinely worth recording (a non-obvious decision, a
  deliberate-but-odd implementation, a tricky learning, or a sharp caveat), spawn a
  **background fork** to distill it.
- **Claude Code**: use the Agent tool with **`subagent_type` omitted** (inherits the
  conversation context, cache-warm) and the prompt: *"Run /cockpit scribe to distill the
  work we just completed into cockpit decision-trail entries."* Fire-and-forget.
- **Codex**: spawn a background sub-agent with `fork_context: true` and no `agent_type`,
  prompt stating it runs under Codex and must pass `--provider codex`.
- Volume bias: one fork per logical chunk, skip trivial edits. No `cockpit start` needed —
  the first scribe write auto-registers the session.

Keep the "best-effort / may fade over a long session" caveat. Do **not** turn scribe into a
custom subagent_type — that breaks context inheritance.

### Codex note

Codex has no SessionStart hooks, so `/thoughtful` is the **only** way to enable auto-logging
there. Make the command self-contained for both surfaces.

## Acceptance criteria

- [x] `packages/monitor/commands/thoughtful.md` exists with frontmatter + the standing instruction body.
- [x] The command instructs Claude to spawn the fork with `subagent_type` omitted, running `/cockpit scribe`.
- [x] The command covers the Codex path (`fork_context: true`, `--provider codex`).
- [x] The command states no `cockpit start` is needed (auto-register on first write).
- [x] `packages/monitor/skills/thoughtful/` is deleted.

## Verification

- [x] `test -f packages/monitor/commands/thoughtful.md && test ! -d packages/monitor/skills/thoughtful && echo ok` prints `ok`.
- [x] `grep -n "subagent_type\|/cockpit scribe\|provider codex" packages/monitor/commands/thoughtful.md` matches all three.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | command missing or spawns wrong fork type | works on Claude only / old skill left | both surfaces covered; subagent_type omitted; old skill deleted |
| Test coverage | ×2 | no checks | existence only | file-exists + skill-gone + grep-for-key-instructions |
| Interface & readability | ×1 | unclear when to fire | acceptable | clear WHEN/HOW + skip rules |
| Assumptions & docs | ×1 | drops the no-custom-agent rationale | partial | states why subagent_type stays omitted |

## Out of scope

- The SessionStart hook that auto-injects this on Claude — Deferred to the hook task in this bucket.
