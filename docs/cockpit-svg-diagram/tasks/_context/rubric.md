# Eval rubric

> The scale and the dimension definitions live here. Each task file still carries its own threshold line and weighted table, so it stays self-contained for the linter and the scorer.

## Scoring scale

Every dimension is scored 0–5.

- **0–1 (fail)** — the dimension was not addressed, or what was produced is wrong.
- **2–3 (below bar)** — the obvious case works; edge cases, failure paths, or the stated constraint drift.
- **4–5 (pass)** — matches the spec including its edge cases, with the reasoning visible in the code or the tests.

## Scoring and pass line

Weighted average = Σ(score × weight) ÷ Σ(weight), on the same 0–5 scale. A task passes when the average clears its threshold **and** no veto fires. A veto is absolute: a vetoed task fails no matter how high the average is.

Every task in this plan uses `>= 4.0`. The operator is inclusive on purpose: the scale above defines 4 as the bottom of the pass band, so a task scoring 4 on every dimension must pass. A strict `> 4.0` would fail it and contradict the scale.

## Per-bucket dimensions

This plan uses **one rubric per bucket**, because the three buckets fail in different ways: the CLI bucket's real risk is silently breaking existing Mermaid callers, the UI bucket's real risk is a sanitize or scoping hole, and the docs bucket's real risk is describing behaviour that was not shipped.

### `cli/` — Correctness ×3 · Backward compatibility ×2 · Test coverage ×2 · Interface & readability ×1

Veto: `Correctness < 4`.

- **Correctness** — does it do what the task specifies, including the edge cases named in the acceptance criteria?
- **Backward compatibility** — is an existing Mermaid call site provably unaffected? Is a record written without a diagram, or with a Mermaid diagram, byte-identical to before? Does a new lint degrade silently when happy-dom is unavailable, rather than blocking a write?
- **Test coverage** — are the failure paths and the degrade path covered, not only the happy path?
- **Interface & readability** — pure functions where the logic is pure, I/O confined to its own function, clear types, no `interface`.

### `ui/` — Correctness ×3 · Sanitize & scoping boundary ×3 · Test coverage ×2 · Interface & readability ×1

Veto: `Correctness < 4` **or** `Sanitize & scoping boundary < 4`.

- **Correctness** — does the rendering path behave as specified, including the format routing and the failure return?
- **Sanitize & scoping boundary** — can any author-supplied content escape its figure? A style rule that matches outside the figure, a surviving remote URI, a surviving `<script>` or event handler, or a rule passed through because the pass could not parse it, all score 0–1. This dimension is weighted equal to Correctness because it is the one thing in this plan that can damage something outside the feature.
- **Test coverage** — is there a test that asserts the hostile case fails to escape, not only that the benign case renders?
- **Interface & readability** — DOM-bound work stays lazy so `diagram.js` remains importable under plain Bun; module boundaries are clean.

### `docs/` — Accuracy vs shipped behaviour ×3 · Actionability for an agent author ×2 · Concision & style-guide fit ×1

Veto: `Accuracy vs shipped behaviour < 4`.

- **Accuracy vs shipped behaviour** — every claim was checked against the code as it now stands. A documented flag, token, or error message that does not exist scores 0–1.
- **Actionability for an agent author** — after reading it, an agent knows when to reach for SVG, when not to, and what will be stripped. Vague advice scores 2–3.
- **Concision & style-guide fit** — one instruction per sentence, starting with a verb; condition before instruction; one term per thing; no word that carries no meaning.

## Final review

The closing task does not re-score the individual tasks. It scores the whole: integration, whether the plan's goal was met, consistency across the CLI / frontend / docs layers, and regressions. Its own table names those dimensions.
