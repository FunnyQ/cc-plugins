# Eval rubric — shared scale and dimensions

> Every task carries its own `## Eval rubric` with a threshold line and a weighted table, so the
> linter and the scorer can read it standalone. This file pins the scale and the generic dimension
> definitions once, so task tables only need task-specific anchors.

## Scoring scale

Each dimension scores **0–5**.

| Score | Meaning |
|---|---|
| 0–1 | Fails. The work does not do what the task asked, or the check was never run. |
| 2–3 | Below bar. The happy path works; edges, failures, or clarity are missing. |
| **4** | **Passes.** Everything the task states is done, including the edge cases it names, with the evidence to prove it. This is the target — a 4 is a good result, not a grudging one. |
| **5** | Passes, and goes beyond what was written: a failure mode the task did not anticipate is handled, or a seam is left materially easier for the next task than the spec required. Never awarded for extra scope. |

Four and five are deliberately separated because the pass line is `≥ 4.0` — an implementation that
does everything asked scores straight 4s and **passes**. A 5 is not required anywhere, and a task
whose scores are all 4s should not read as a near miss.

## Generic dimensions

- **Correctness** (×3) — does the code do what the task specified, including the edge cases the
  task named? A plausible implementation that fails a stated edge case scores 2–3, not 4.
- **Test coverage** (×2) — do the tests exercise failure paths and boundaries, not just the happy
  path? Tests that only assert the shape of a return value score 2–3.
- **Interface & readability** (×1) — are the exported functions pure where they can be, with clear
  `type` declarations and names that match the domain vocabulary in this plan?
- **Assumptions & docs** (×1) — are non-obvious constants, ported values, and deliberate omissions
  explained in a comment that says *why*, not *what*?

## Acceptance criteria gate first, then score

**A task's `## Acceptance criteria` are binary and individually mandatory.** Every box must be
checked before the rubric is applied at all. The score measures how well the work was done, never
whether it was done — and a weighted average is exactly the wrong instrument for the second question,
because averaging lets a strong dimension pay for a missing one.

Concretely: Test coverage 3 means required cases are absent, and a Correctness 5 must not buy them
back. If a dimension lands below 4, look for the acceptance criterion it corresponds to; usually one
is unmet and the task has not actually finished.

## Scoring and pass line

Weighted average = Σ(score × weight) ÷ Σ(weight), on the same 0–5 scale.

- **Pass**: weighted average **≥ 4.0** — an implementation that does everything the task states scores straight 4s and passes.
- **Hard-fail veto**: `Correctness < 4` fails the task regardless of the average.

Two tasks in this plan tighten the anchors rather than the threshold, because their failure modes
are silent rather than loud:

- The trail-reader extraction, because a regression there breaks the already-shipped `/chronicle:pr`.
- The archiver, because it is the only component that writes under `.cockpit/`, and a bad move corrupts an
  append-only source.

Their tables spell out what a 4 requires in those specific terms. The threshold stays `≥ 4.0`.
