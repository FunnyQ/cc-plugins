# Shared rubric

## Scoring scale

- **0–1 (fail)** — wrong, missing, or contradicts the contract in `protocol.md` / `shared.md`.
- **2–3 (below bar)** — works on the happy path; an edge case, a failure path, or a contract detail drifts.
- **4–5 (pass)** — matches the contract exactly, failure paths named in the task behave as specified, nothing extra.

## Generic dimensions

- **Correctness** — behaviour matches the task's acceptance criteria and the signatures in `protocol.md`,
  byte for byte where a string or a path is specified.
- **Test coverage** — every acceptance criterion has a test in the plugin test kit; failure paths are tested,
  not just the happy path.
- **Interface & readability** — pure functions stay pure; names say what a thing is; no comments that restate
  code; `type`, never `interface`; style matches the surrounding file.
- **Assumptions & docs** — any engine behaviour the code relies on that the typings do not state is either
  tested or carries a one-line why; no unmarked magic numbers outside the constants `protocol.md` names.

## Scoring & pass line

Weighted average = Σ(score × weight) ÷ Σ(weight), 0–5. Pass when the average is > 4.0 and no veto fires.
`Correctness < 4` is an automatic veto on every task.
