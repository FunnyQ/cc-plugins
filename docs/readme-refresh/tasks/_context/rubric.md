# Shared eval rubric

The default graded bar for every content task in this tree. The closing final-review task overrides it,
because it scores holistic axes instead.

`## Acceptance criteria` is the **binary gate** — pass or fail, no partial credit. This rubric is the
**graded quality score** layered on top of a passed gate. A task is done only when both hold.

> Score each dimension 0–5. Pass needs a weighted average **> 4.0**. `Correctness < 4` is an automatic
> veto regardless of the average.

| Dimension | Weight | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| Correctness | ×3 | A stated fact is wrong, or the edit lands in the wrong place in the file. | Every fact checks out but a detail the task named is missing. | Every claim matches the packages as they actually ship, and the edit lands exactly where the task said. |
| Verification evidence | ×2 | No command run, or the summary asserts a result with no output. | A command was run but its actual output is not quoted. | Every `## Verification` command was run and its actual output is quoted in the summary. |
| Voice & consistency | ×1 | Reads as a different document — marketing tone, emoji, or a new section shape. | Readable but drifts from the surrounding sections. | Indistinguishable in voice and structure from the sections around it. |
| Scope | ×1 | Edited a file or a line the task did not name. | Rewrote nearby prose that was not asked for. | Touched only what the task named; unrelated problems reported, not fixed. |

## Scoring notes for the judge

- Ground **Correctness** in the binary gate's captured evidence — the commands actually run and their
  output — not in the dev agent's prose.
- **Verification evidence** is about proof, not effort. A confident summary with no quoted command
  output scores 0–1 however plausible it reads.
- Weighted average = Σ(score × weight) ÷ Σ(weight), on the same 0–5 scale. `score-task.ts` computes it;
  never recompute the arithmetic by hand.
