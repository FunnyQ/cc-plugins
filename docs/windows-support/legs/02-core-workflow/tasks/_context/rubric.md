# Rubric

## Scoring scale

- **0–1 (fail)** — wrong, missing, or breaks an existing behaviour.
- **2–3 (below bar)** — works on the happy path but drifts on an edge case, a platform, or a stated constraint.
- **4–5 (pass)** — matches the spec on every platform it names, edge cases handled, nothing outside the task changed.

## Generic dimensions

- **Correctness** — the change does exactly what the task specifies on macOS, Linux and Windows, and changes nothing for macOS or Linux users that the task does not name.
- **Test coverage** — a test fails if the behaviour regresses, including the platform branch the local machine does not take (covered by injecting the platform, not by skipping).
- **Interface & readability** — small, plain code; no layer, option, or abstraction without a current caller; names say what the code does.
- **Assumptions & docs** — every assumption about Windows, Bun, git or an external CLI is either verified by a test or traced to a fact in `windows.md`.

## Scoring & pass line

Weighted average = Σ(score × weight) ÷ Σ(weight), on 0–5. Pass when the average is > 4.0 and no veto fires. Correctness < 4 is an automatic veto.

The final review task scores its own integration dimensions (goal, regressions, integration, consistency, leanness) in place of the generic four, and names its own veto in its threshold line.
