# Shared eval rubric

> Every task's `## Eval rubric` carries its own threshold line and weighted table; this file defines the scale and the generic dimensions so the per-task tables only add task-specific anchors.

## Scoring scale (0–5)

- **0–1 (fail)** — missing, wrong, or breaks something that worked.
- **2–3 (below bar)** — the happy path works; an edge case, an error path, or a compatibility detail drifts from the TS behavior.
- **4–5 (pass)** — matches the contract including edge cases; 5 means a reviewer found nothing to change.

## Generic dimensions

- **Correctness (×3)** — byte-level parity with the TS behavior named in `_context/contracts.md`: same JSON shapes and key order, same status codes, same stdout/stderr/exit codes, same env-var fallbacks, same file writes. The contract tests this task names pass against Rust (and still pass against TS where the task says so).
- **Test coverage (×2)** — the contract tests exercise every route/subcommand/message the task ports, including the failure paths (missing file, bad token, timeout sentinel, dead daemon); Rust-internal logic that the black box cannot reach cheaply (version compare, path resolution, SSE tail offsets) has `cargo test` units.
- **Interface & readability (×1)** — modules mirror the TS module they port; no `unwrap` on external data; no abstraction with one caller; clippy clean.
- **Assumptions & docs (×1)** — any place Rust deliberately differs from TS (and why) is a one-line comment; every new dependency has its justification in `Cargo.toml`; deliberate corner-cuts name their ceiling.

## Scoring & pass line

Weighted average = Σ(score × weight) ÷ Σ(weight) on the 0–5 scale. Pass when the average is > 4.0 and no veto fires. **Correctness < 4 is an automatic veto** on every task.

The final review adds **Leanness (×1)**: does the whole diff carry abstractions with one caller, config nobody sets, or hand-rolled versions of what a chosen crate already provides? Score the judgement, not the line count.
