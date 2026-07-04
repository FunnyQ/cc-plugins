# Eval rubric — shared scale & dimensions

> Each task carries its own `## Eval rubric` (threshold line + weighted table) so the linter and
> `score-task.ts` can parse it standalone. This file pins the shared scale and the generic dimension
> meanings so per-task tables only need task-specific anchors.

## Scoring scale (0–5, per dimension)

- **0–1 (fail)** — wrong, missing, or actively misleading.
- **2–3 (below bar)** — happy path works but edges drift, unclear, or inconsistent with conventions.
- **4–5 (pass)** — fully matches spec, edges handled, clear, consistent with the repo.

## Scoring & pass line

- Weighted average = Σ(score × weight) ÷ Σ(weight), on the same 0–5 scale.
- **Default pass threshold: `> 4.0`.**
- **Hard-fail veto: `Correctness < 4` is an automatic veto** — a task cannot pass on a strong average if
  it is materially incorrect.

## Two dimension sets

### A. Code tasks (with unit tests) — used by `scripts/01` and `scripts/02`

| Dimension | Looks at |
|---|---|
| Correctness ×3 | Does the code do exactly what the spec says, including edge cases? |
| Test coverage ×2 | Are the pure helpers tested, including failure paths, not just the happy path? |
| Interface & readability ×1 | Pure functions, clear types, an impure CLI wrapper that composes them cleanly. |
| Assumptions & docs ×1 | Magic values flagged, assumptions explained, determinism preserved (no `Date.now()` in tested helpers). |

### B. Docs / integration tasks (no unit tests) — used by `skill/01`, `integration/01`, `integration/02`

| Dimension | Looks at |
|---|---|
| Correctness ×3 | Do the instructions / edits match reality (real verb signatures, real file paths, working regex)? |
| Completeness ×2 | Is everything an executor/user needs present — no dangling "TODO", no missing step? |
| Clarity & consistency ×1 | Reads cleanly and consistently with the sibling skills' voice and structure. |
| Conventions ×1 | Follows repo conventions (frontmatter fields, versioning, CHANGELOG format, commit style). |

The final review task defines its own holistic dimensions (integration, meets-the-goal, no-regressions)
in its file rather than reusing either set above.
