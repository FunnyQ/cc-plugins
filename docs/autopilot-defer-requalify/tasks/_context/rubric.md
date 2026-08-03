# Shared eval rubric

> Every task carries its own `## Eval rubric` with a threshold line and a weighted table —
> the linter and the scorer parse those per task. This file pins the scale and the generic
> dimension meanings so task tables only need their task-specific anchors.

## Scoring scale

Every dimension is scored 0–5.

- **0–1 — fail.** The requirement is not met, or it is met in a way that breaks something else.
- **2–3 — below bar.** The happy path works, but edge cases, tests, or clarity fall short.
- **4–5 — pass.** Fully matches the spec, edge cases handled, and a later reader can tell why.

## Generic dimensions

- **Correctness** (×3) — does it do what the task specified, including the edge cases the task
  names? For work on the orchestrator script, "correct" includes *not* silently changing the
  rendered text of a prompt the task did not ask you to change.
- **Test coverage** (×2) — are the new paths actually exercised, including the failure paths
  and the concurrency ordering, not just the happy path? A test that would still pass with the
  change reverted counts as no coverage.
- **Interface & readability** (×1) — clear names and types, no indirection used once, and the
  surrounding file's existing style matched rather than a new one introduced.
- **Assumptions & docs** (×1) — non-obvious choices carry a *why* comment. This codebase's
  house style is that comments explain why, never what.

## Scoring & pass line

Weighted average = Σ(score × weight) ÷ Σ(weight), on the same 0–5 scale.

- **Pass threshold: `> 4.0`.**
- **Hard-fail veto: `Correctness < 4`** fails the task regardless of the average.

**A 4 in every dimension does not pass, and that is deliberate.** The average would be exactly
4.0, and the bar is *above* it. Read the bands accordingly: 4 is the lowest acceptable score for
a single dimension, not a passing overall result. Clearing the line takes at least one dimension
scored 5 — in practice the weighted ones, since Correctness alone carries three sevenths of the
average. Do not "fix" this by relaxing the operator; the veto and the strict threshold are the
two things keeping a uniformly adequate implementation from being graded as a good one.

The default weights are `Correctness ×3 / Test coverage ×2 / Interface & readability ×1 /
Assumptions & docs ×1`. The closing review task scores different axes — integration, meeting
the plan's goal, consistency, and absence of regressions — on the same scale and threshold.
