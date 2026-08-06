# ADR-0020: Autopilot commits with reverse pathspec exclusion

- Status: Accepted
- Date: 2026-08-02

## Context

Following ADR-0019's fix (parallel-wave commits had been fully stopped after
one escalation), the old guard was found not to be a safe baseline: it
stopped commits but never stopped the loop itself. After a `park`, the loop
kept running while the worktree stayed dirty with foreign changes from that
point on — the exact precondition behind a separate, previously traced defect.

## Considered alternatives

Four options were scored on two axes — history cleanliness and worktree
cleanliness:

- Commit everything unconditionally. Bad history: failed work enters history,
  and the closing Final review reads it as a finished product.
- The old guard: stop all commits whenever any escalation exists. Bad
  worktree: the loop keeps running past a park without committing, so every
  gate after that point runs against an increasingly dirty tree.
- Positive pathspec — commit only the files a passing task declared. Bad
  worktree: passing tasks inevitably touch undeclared byproducts (test
  fixtures, snapshots, lockfiles), which stay uncommitted on the tree.
- Reverse pathspec — commit everything except files a parked task declared.
  Clean on both axes. Adopted.

## Decision

Adopt reverse pathspec exclusion. A `heldBack` set accumulates every parked
task's declared file paths for the entire run and is never cleared.
`commitBlocked()` replaces the old `escalations.length === 0` check — only
escalations that make the whole tree untrustworthy still block a commit.
`commitInstructions(agentLabel, heldBack)` adds a step 0 that reads the
parked task's own `## Files to create / modify` list and excludes exactly
those paths — but the task file itself is still committed, since
`Status: blocked` is a real, meaningful state. Both call sites (between waves
and post-loop) were updated, along with three stale "escalation-free guard"
comments.

## Consequences

Commits are recoverable (`git revert`) if wrong, which the old worktree-reset
approach was not — a prior `git checkout` incident had already proven
uncommitted worktree changes are unrecoverable. Every subsequent gate now
runs against a tree that only ever carries genuinely completed work plus
explicitly parked task files, never other in-flight changes. This is the
core commit-safety mechanism for every parallel-wave autopilot run.

## Evidence

- **The prior guard stopped commits but never stopped the loop** — a park
  left the worktree dirty from that point forward while the loop kept
  running, which was the precondition behind a previously traced defect.
  Four options scored on history/worktree cleanliness showed only reverse
  pathspec (commit everything except a parked task's declared files) keeps
  both clean; positive pathspec still leaves undeclared byproducts
  (fixtures, snapshots, lockfiles) uncommitted.
  Session `78456efd-9618-4022-afe9-cb7ea96486dc`, entry `8808d217-8d1e-4edb-9a8a-3d8ddc99cd65`, 2026-08-02.
