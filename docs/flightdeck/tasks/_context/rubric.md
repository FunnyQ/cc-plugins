# Eval rubric — shared quality bar

> Every task carries its own `## Eval rubric` with a threshold line and a weighted table, because the
> linter and scorer parse each task file independently. This file defines the scale and the generic
> dimensions once, so per-task tables only need task-specific anchors.

## Scoring scale

Each dimension scores **0–5**.

- **0–1 (fail)** — the dimension is absent or actively wrong. A reviewer would reject on this alone.
- **2–3 (below bar)** — the happy path works, but edges, failures, or clarity are missing. Would need
  a follow-up commit before anyone relied on it.
- **4–5 (pass)** — matches the spec including edge cases, and a stranger could maintain it.

Score the **real code as written**, grounded in the verification evidence. Not intent, not the task
description.

## Generic dimensions

- **Correctness ×3** — does it do what the task's Goal and Acceptance criteria say, including the
  edge cases named in the Implementation notes? Ground this in the actual verification output.
- **Test coverage ×2** — are the exported pure functions unit-tested with `bun test`? Do the tests
  cover failure paths and edge inputs, not just the happy path? A task whose only test is "it returns
  something" is a 2.
- **Interface & readability ×1** — are the exported types and signatures clear? Is I/O kept out of the
  pure functions? Would the next reader understand it without asking?
- **Assumptions & docs ×1** — are non-obvious decisions explained in a comment giving the *reason*?
  Are magic numbers named? Are unresolved assumptions flagged rather than buried?

## The `ui` bucket adds one dimension

- **Design fidelity ×2** — does the result match the Hangar system exactly: the named colour tokens,
  the type scale, the 4px spacing steps, the 4px radius ceiling, the anti-goals list? A screen that
  looks fine but invents its own spacing or colours scores 2 at best. A screen that violates a stated
  anti-goal scores 0–1.

The `ui` bucket's total weight is therefore 9, not 7. The threshold and veto are unchanged.

## Scoring and pass line

Weighted average = Σ(score × weight) ÷ Σ(weight), on the same 0–5 scale.

A task passes when the weighted average is **> 4.0** *and* no veto fires.

**Hard-fail veto: `Correctness < 4` is an automatic veto.** A task that does not actually work cannot
be rescued by strong tests or a tidy interface.

`score-task.ts` computes this deterministically from the task's own table. Do not re-derive the
arithmetic by hand.
