# Shared eval rubric

> Every task carries its own `## Eval rubric` with a threshold line and a weighted table, because the linter and the scorer parse each task file on its own. This file defines the scale and the generic dimension meanings so those tables only need task-specific anchors.

## Scoring scale

Each dimension scores 0–5.

| Band | Meaning |
|---|---|
| **0–1** | Fails. The work does not do what the task asked, or it does it in a way that has to be redone. |
| **2–3** | Below bar. The happy path works, but edge cases, failure paths, or the contract with neighbouring work have drifted. |
| **4–5** | Passes. Fully matches the spec including its edge and failure paths, and a reviewer with no context can follow it. |

## Generic dimensions

- **Correctness** — does the deliverable match the spec, including the edge and failure paths the task named? For a docs task this means every claim is true of the repo as it stands, not as someone remembers it.
- **Test coverage** — are the pure functions tested across the cells the task touched, including the failure paths? No real OpenCode process in a unit test. A docs-only task scores this on whether its claims were actually verified against the repo, not on test files.
- **Interface & readability** — pure logic separated from I/O, `type` over `interface`, no abstraction with a single caller, no option nobody sets. A reader should not have to hold two files in their head.
- **Assumptions & docs** — anything depending on an unresolved runtime fact cites it explicitly rather than assuming; failure modes are documented; nothing is left as an unmarked magic value.

## Scoring and pass line

Weighted average = Σ(score × weight) ÷ Σ(weight), on the same 0–5 scale.

- **Pass**: weighted average **> 4.0**.
- **Hard-fail veto**: `Correctness < 4` fails the task regardless of the average.

A task may add or rename dimensions when its work calls for it — the weights just have to be positive and the threshold line has to stay parseable.

## The non-regression bar applies to every task

Claude Code and Codex must behave identically after this work. Any task that modifies a file under `packages/` in a way beyond **adding** a clearly fenced OpenCode section — or that touches a `.ts`, a `plugin.json`, or a hook script there at all — scores **Correctness 0**, whatever else it got right. The do-not-touch list is in `shared.md`.
