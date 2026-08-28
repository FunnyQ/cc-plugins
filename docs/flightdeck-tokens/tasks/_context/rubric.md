# Shared eval rubric

Every task in this plan is scored on this bar unless its own file states otherwise.

- **Scale**: 0–5 per dimension.
- **Pass**: weighted average `> 4.0`.
- **Veto**: `Correctness < 4` is an automatic fail regardless of the average.

| Dimension | Weight |
|---|---|
| Correctness | ×3 |
| Test coverage | ×2 |
| Interface & readability | ×1 |
| Assumptions & docs | ×1 |

Weighted average = Σ(score × weight) ÷ Σ(weight).

## What each dimension means here

**Correctness** carries ×3 because this feature's failure mode is a number that is
silently wrong. A mis-paired agent, a drifted byte cursor, or a double-counted turn
produces a plausible figure nobody can spot as false. Prefer a visibly missing number
over a quietly wrong one: when the code cannot establish a fact, it must return
`undefined` or `null`, never a zero that renders as a real measurement.

**Test coverage** carries ×2 because most of this work is pure functions over
well-understood inputs, so there is no excuse for untested edges. Test the boundaries
that actually bite: an empty input, a malformed JSON line, a file that shrank, a
timestamp tie, a group whose two sides have different lengths.

**Interface & readability** — keep I/O at the edges. Parsing, pairing, and summing are
pure functions taking data and returning data. A function that reads the filesystem
*and* decides something is the shape to avoid.

**Assumptions & docs** — every fact this feature relies on about Claude Code's on-disk
layout is an assumption about someone else's undocumented format. Where the code
depends on one, say so in a comment naming the observed evidence, so a future reader
knows what to re-verify when the format moves.

## Closing gate

The final-review task does not re-score individual tasks. It scores integration,
whether the plan's goal was met, consistency across the tree, absence of regressions,
and leanness. Its own file carries that table.
