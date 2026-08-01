# Shared eval rubric

The default graded bar for every implementation task in this tree. A task may override it; the closing
Final review task does, because it scores holistic axes instead.

`## Acceptance criteria` is the **binary gate** — pass or fail, no partial credit. This rubric is the
**graded quality score** layered on top of a passed gate. A task is only done when both hold.

> Score each dimension 0–5. Pass needs a weighted average **> 4.0**. `Correctness < 4` is an automatic
> veto regardless of the average.

| Dimension | Weight | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| Correctness | ×3 | The change does not do what the task asked, or it breaks existing behaviour. | Works on the happy path; an edge case named in the task is unhandled. | Does exactly what the task specified, including every edge case the task names. |
| Test coverage | ×2 | No test, or a test that would pass without the change. | Tests the happy path only. | Tests the behaviour *and* the failure/edge cases the task calls out, and each test would fail without the change. |
| Interface & readability | ×1 | Confusing names, dead code, or a needless abstraction. | Readable but drifts from the surrounding style. | Matches the file's existing style and naming; a new export has an obvious contract. |
| Assumptions & docs | ×1 | Silent assumptions; a stale comment left behind. | Assumptions noted somewhere. | Every non-obvious choice is recorded next to the code as a *why* comment, and no doc it contradicts is left stale. |

## Scoring notes for the judge

- Ground **Correctness** in the binary gate's captured evidence — the commands actually run and their
  output — not in the dev agent's prose.
- **Test coverage** asks whether each new test would fail without the change. A test that passes on the
  unmodified file scores 0–1 for that item however thorough it looks.
- Weighted average = Σ(score × weight) ÷ Σ(weight), on the same 0–5 scale. `score-task.ts` computes it;
  never recompute the arithmetic by hand.
