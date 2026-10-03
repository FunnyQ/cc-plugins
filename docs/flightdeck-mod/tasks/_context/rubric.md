# Shared rubric

> Every task's `## Eval rubric` carries its own threshold line and weighted table. This file pins the scale and the generic dimensions so tasks need only task-specific anchors.

## Scoring scale (0–5)

- **0–1 (fail)** — missing, wrong, or contradicts `shared.md`.
- **2–3 (below bar)** — the happy path works; edges, failure paths, or the contract drift.
- **4–5 (pass)** — matches `shared.md` exactly, edges handled, nothing extra.

## Generic dimensions

- **Correctness** — output matches the `DeckSnapshot` contract and the pane decisions in `shared.md`, including the failure paths (missing plan, stale snapshot, cycles).
- **Test coverage** — pure logic has `bun test` cases for edges and failures; mod behaviour has `claude plugin test` cases.
- **Interface & readability** — pure functions with clear types; I/O at the edges; follows surrounding repo style.
- **Assumptions & docs** — magic numbers named; corner-cuts carry their ceiling and upgrade trigger in one comment.
- **Leanness** (final review only) — no abstraction with one caller, no unused option, no hand-rolled copy of the reused flightdeck code.

## Scoring & pass line

Weighted average = Σ(score × weight) ÷ Σ(weight). Default pass: `> 4.0` on the 0–5 scale. `Correctness < 4` is an automatic veto.
