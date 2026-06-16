# Eval rubric — shared scale & dimensions

> Each task's `## Eval rubric` carries its own threshold line + weighted table (that's what
> the linter and scorer parse). This file pins the **scale** and the **generic dimension
> meanings** so tasks only need task-specific anchors.

## Scoring scale (0–5, per dimension)

- **0–1 (fail)** — wrong result, doesn't match the spec, or absent.
- **2–3 (below bar)** — happy path works but edge cases drift, or work is incomplete.
- **4–5 (pass)** — fully matches the spec, edge cases handled, clean and reviewable.

## Generic dimensions

- **Correctness** — does the change do exactly what the task specifies, including edge
  cases and the "do not break X" constraints. For frontend tasks (no automated tests here),
  this folds in **no visual/behavior regression** confirmed on the owner's dev server.
- **Test coverage** — for backend tasks, unit tests cover the new/changed behavior plus
  failure paths. For frontend/docs tasks where automated tests don't apply, score this on
  whether a concrete manual verification path is specified and followed.
- **Interface & readability** — clear types (`type` over `interface`), pure functions where
  possible, naming consistent with surrounding code, surgical diffs.
- **Assumptions & docs** — assumptions flagged, no unexplained magic, docs/comments updated
  where the change affects documented behavior.

## Scoring & pass line

- Weighted average = Σ(score × weight) ÷ Σ(weight), on the 0–5 scale.
- **Default pass threshold: `> 4.0`.**
- **Hard-fail veto: `Correctness < 4`** sinks the task regardless of the average.
- Default weights: Correctness ×3 / Test coverage ×2 / Interface & readability ×1 /
  Assumptions & docs ×1. Tasks may adjust anchors but keep the threshold + weighted shape.
