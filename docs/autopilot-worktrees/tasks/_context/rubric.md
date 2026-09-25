# Shared rubric

> Every task's `## Eval rubric` carries its own threshold line and weighted table; this file defines the scale and the generic dimensions so tasks need only task-specific anchors.

## Scoring scale (per dimension, 0–5)

- **0–1 (fail)** — wrong, missing, or breaks something that worked.
- **2–3 (below bar)** — the happy path works, but an edge case, a frozen decision, or a convention drifts.
- **4–5 (pass)** — matches the task and the decisions in `shared.md`, `models.md`, and `worktree.md`, edge cases handled, nothing extra.

## Generic dimensions

- **Correctness** — does the change do exactly what the task and the `_context/` files state (names, syntax, defaults, ordering), with no behaviour change outside the task's scope?
- **Test coverage** — are normal, boundary, and failure inputs covered by `bun test`, and do the task's named existing test files still pass?
- **Interface & readability** — `type` over `interface`, the surrounding file's idiom, no one-caller indirection, no option nobody sets, comments say why in one line.
- **Assumptions & docs** — measured facts and guesses are marked in a one-line comment; docs the task names are updated; no unmarked magic numbers.

## Scoring & pass line

- Weighted average = Σ(score × weight) ÷ Σ(weight), on the 0–5 scale.
- Pass: weighted average > 4.0.
- Hard fail: Correctness < 4 is an automatic veto on every task, whatever the average. The closing review carries its own vetoes.
