# Eval rubric — shared scale & dimensions

> Per-task `## Eval rubric` tables carry their own threshold line + weighted dimensions (that's what `lint-task.ts` / `score-task.ts` parse). This file pins the **scale** and the **generic dimension meanings** so tasks only fill in task-specific anchors.

## Scoring scale (0–5 per dimension)

- **0–1 (fail)** — wrong result, doesn't match spec, or absent.
- **2–3 (below bar)** — happy path works but edges drift, types unclear, or tests thin.
- **4–5 (pass)** — fully matches spec, edge cases handled, clear and composable.

## Generic dimensions

- **Correctness** — does the code do what the task spec says, including edge cases and failure paths? For relay: correct argv built per CLI, correct parsing of each CLI's output shape, correct gate/strategy decisions.
- **Test coverage** — are pure functions unit-tested across the matrix cells they touch (every backend×mode they implement), including failure paths (gate rejection, empty/malformed CLI output)? No real CLI spawn in unit tests.
- **Interface & readability** — pure functions kept free of I/O; `type` over `interface`; clear names; backend code never leaks into the mode layer and vice versa.
- **Assumptions & docs** — magic numbers/model ids labeled; CLI-version assumptions and known caveats (e.g. opencode #26855) flagged in comments.

## Scoring & pass line

- Weighted average = Σ(score × weight) ÷ Σ(weight), on the 0–5 scale.
- **Default pass threshold: > 4.0.**
- **Hard-fail veto: Correctness < 4** is an automatic fail regardless of the average.
