# Shared scoring bar

## Scoring scale

Score each dimension from 0 to 5. Use 0–1 for absent or wrong behavior, 2–3 for happy-path behavior with material omissions, and 4–5 for the specified behavior including edge cases and failures.

## Generic dimensions

- **Correctness**: satisfy the task's platform and failure contracts without changing unrelated behavior.
- **Test coverage**: reproduce the actual failure mechanism and exercise both supported and rejected paths.
- **Interface & readability**: keep plugin-local helpers small, named and explicit; avoid one-caller abstraction layers without a concrete need.
- **Assumptions & docs**: distinguish native CI, injected-platform, automated and owed-human evidence.

## Scoring and pass line

Calculate weighted average as sum(score × weight) / sum(weight). Require average > 4.0. Veto when Correctness < 4. Use Correctness ×3, Test coverage ×2, Interface & readability ×1 and Assumptions & docs ×1.

Include the threshold and a weighted table with task-specific anchors in every task; a reference here alone does not satisfy the task parser.

## Final review

Use Integration ×3, Goal coverage ×3, No regressions ×2, Consistency ×1 and Leanness ×1. Require average > 4.0. Veto when Integration < 4 or Goal coverage < 4. Judge the complete execution diff and the composed behavior; do not repeat the individual task scores. Leanness scores unnecessary layers and configuration, never raw line count.
