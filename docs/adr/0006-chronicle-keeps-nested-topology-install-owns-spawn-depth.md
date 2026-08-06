# ADR-0006: Chronicle keeps nested subagent topology; install owns the spawn-depth prerequisite

- Status: Accepted
- Date: 2026-07-22

## Context

Claude Code 2.1.217 disabled nested subagent spawning by default. Chronicle's
architecture (thin `SKILL.md` → orchestrator agent → child agents) depends on
spawn depth 2. Without `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` set high enough,
every chronicle orchestrator fails with "Agent exists but is not enabled in
this context."

## Considered alternatives

- Flatten to the main agent spawning children directly (needs only depth 1,
  no env var dependency). Rejected: folds the orchestrator's decision layer
  back into the main conversation, losing the existing isolation.
- Pin chronicle back to 0.9.0. Rejected: ineffective — the topology causing
  the failure is unchanged.
- Ask users to downgrade Claude Code to 2.1.216. Rejected: only delays the
  problem and locks users to an old version.
- Print a reminder and require the user to edit global settings by hand.
  Rejected: breaks the out-of-the-box experience for every new install.

## Decision

Keep the nested topology unchanged. The `install` skill becomes the owner of
this prerequisite for both harnesses: a `SessionStart` hook runs
`setup-spawn-depth.ts --session-check`, which writes
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2` into `~/.claude/settings.json`
automatically whenever the value is missing or too low. Depth 2 is chosen as
the minimum sufficient value (`main → orchestrator → child`), not 3.

## Consequences

All three chronicle skills' verify steps now recognize this specific error
and are explicitly forbidden from silently falling back to manual
commit/release — a silent downgrade to manual operation is judged worse than
a hard, visible failure. The env var is read only at session start, so the
session that performs the write still needs a restart before chronicle works.

## Evidence

- **Four alternatives to preserving nested topology were traced and rejected**
  — flattening loses orchestrator isolation, version-pinning chronicle is a
  no-op against the real cause, downgrading Claude Code only delays the
  problem, and print-only reminders break zero-config install. `install` now
  self-owns the prerequisite via a `SessionStart` hook that writes depth 2
  automatically when missing or too low.
  Session `ac0a0fe6-086c-49bb-8479-4ba0e1f8ff8d`, entry `1d507d19-dd07-4ccd-a44a-c064c6f29d8e`, 2026-07-22.
