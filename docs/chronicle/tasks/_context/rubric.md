# Eval rubric — shared scale & dimensions

> Each task's `## Eval rubric` carries its own threshold line + weighted table (that's what the linter and scorer parse). This file pins the **scale** and the **generic dimension meanings** so tasks only need their task-specific anchors.

## Scoring scale (every dimension, 0–5)

- **0–1 (fail)** — wrong, missing, or actively harmful.
- **2–3 (below bar)** — happy path works but edges drift, or the shape is off.
- **4–5 (pass)** — fully matches the spec, edge cases handled, clean.

## Pass line (Correctness-weighted)

- **Weighted average > 4.2 to pass.** (Higher than the default 4.0 — this plugin holds a high quality bar.)
- **Hard-fail veto: `Correctness < 4` is an automatic veto** regardless of the average.
- Weighted average = Σ(score × weight) ÷ Σ(weight), on the same 0–5 scale.

## Generic dimension meanings

- **Correctness ×4** — does it do exactly what the task spec says, including edge cases? Weighted heaviest; a sub-4 here vetoes the task.
- **Test coverage ×2** — for script tasks: unit tests cover the pure functions, edges, and failure paths via `bun test`.
- **Trigger & flow correctness ×2** — for SKILL.md / prose tasks (which can't be unit-tested): the trigger config fires on the right phrases, and the documented orchestration flow is internally consistent and executable. Use this in place of "Test coverage" on prose tasks.
- **Interface & readability ×1** — pure functions, clear `type`s, easy to compose; I/O kept at the edges.
- **Assumptions & docs ×1** — magic numbers flagged, assumptions explained, sources cited.

## Final review task

The closing `packaging/03-final-review` task scores *integration-level* axes (does it compose, meets the PLAN goal, consistency, no regressions), not a re-score of individual tasks. It carries its own table with those dimensions.
