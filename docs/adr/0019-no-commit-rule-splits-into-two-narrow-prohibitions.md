# ADR-0019: NO_COMMIT_RULE splits into two narrow prohibitions

- Status: Accepted
- Date: 2026-08-02

## Context

A parallel autopilot task used `git checkout` and reverted a sibling task's
file, rolling an already-confirmed `Status: done` task file back to `todo`. A
guardrail was needed, but its exact wording was the actual decision point.

## Considered alternatives

- A single blanket rule: "do not modify any file that does not belong to this
  task." Rejected: parallel waves legitimately schedule two tasks against the
  same source file — a real incident (`launch/02` and `launch/03` both
  legitimately editing `src/flows/agent.rs`, as the plan itself scheduled)
  showed this. The prompt is read literally by the cheap Haiku driver, so a
  blanket prohibition would forbid work the plan itself assigned.

## Decision

Split into two non-overlapping prohibitions instead: (1) never run
restoration-class commands (`git checkout` / `git restore` / `git reset` /
`git clean`) — the prompt must state why: uncommitted changes elsewhere in
the same worktree belong to a still-running sibling; (2) never edit another
task's file under `tasks/` — that file carries that task's own `Status`
line. Editing shared source files is explicitly allowed, including when a
sibling is concurrently editing the same file.

## Consequences

Parallel waves that legitimately share a source file are not blocked by this
rule; only reverting commands and cross-task status-file edits are. This is a
safety-critical guardrail for every parallel-wave run — any future
tightening of it must preserve the shared-source-file case that motivated the
split, or it will reintroduce the original over-broad-rule failure mode in a
different form.

## Evidence

- **A blanket "don't touch files outside your task" rule would have blocked
  legitimate parallel work** — traced against a real incident where
  `launch/02` and `launch/03` both legitimately edited `src/flows/agent.rs`
  per the plan's own scheduling. Split into two narrow prohibitions
  (no restoration commands; no editing another task's own `tasks/` file)
  instead of one broad one, with shared source-file edits explicitly
  permitted.
  Session `5d3c164b-59a2-4caa-a31b-dd96fe72ca5c`, entry `e53d8cc1-829e-4ca7-9ac1-7b8e730efb1e`, 2026-08-02.
