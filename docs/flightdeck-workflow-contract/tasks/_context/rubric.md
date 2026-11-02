# Shared eval rubric

> All tasks in this plan score against this scale and these dimension
> definitions. Each task file still carries its own threshold line and weighted
> table — the linter and `score-task.ts` parse those per task. This file exists
> so those tables only have to state task-specific anchors.

## Scoring scale

Every dimension is scored 0–5.

- **0–1 — absent or wrong.** The dimension was not addressed, or what was
  delivered is incorrect.
- **2–3 — partial.** Present but incomplete: a case is unhandled, a test only
  covers the happy path, a name misleads, an assumption is undocumented.
- **4–5 — complete.** The dimension is fully satisfied. A 5 means a reviewer
  reading it cold would change nothing; a 4 means they might phrase something
  differently but would not ask for a change.

Score the work as delivered, not the intent behind it.

## Dimensions

### Correctness (the veto dimension)

Does the code do what the task said, for every input it can actually receive?
Look at boundary values, empty and absent inputs, malformed data, and the
interaction with concurrent writers. A function that is right on the happy path
and wrong on an empty array is a 2, not a 4.

**A score below 4 on Correctness is an automatic hard fail** regardless of the
weighted average. Everything else in this plan is worthless if the panel shows
a wrong picture confidently.

### Backward compatibility

Does autopilot's existing path still behave identically? This plan edits code
autopilot depends on — the flightlog schema, its parser, and the type
`deriveTaskViews` consumes — and a regression there is silent: the panel keeps
rendering, just wrongly.

Anchors: autopilot's own test suite passes unchanged; an old reader encountering
a new event kind degrades by dropping the line, never by throwing; no existing
exported signature changes meaning without every caller being updated in the
same task.

A task that touches no shared code scores this on whether it _avoided_ touching
shared code unnecessarily — a needless edit to a stable file is not a 5.

### Test coverage

Are the behaviours the task claims actually asserted? A test that would still
pass with the implementation deleted is not coverage. Look for: the failure
modes named in the task file, the boundary cases, and at least one test per
acceptance criterion that is testable at all.

Follow this repo's conventions — see `shared.md` for the style. Pure functions
get in-memory fixtures; anything touching the filesystem gets a real temp
directory, not a mock.

### Interface & readability

Would the next person understand this without asking? Names say what the thing
is. Types are narrow enough to make an illegal state unrepresentable. Comments
explain why, never what, and only where the code cannot. The code reads like the
file it lives in.

Penalize a new abstraction that a current requirement does not force, and an
indirection used exactly once.

### Assumptions & docs

Are the assumptions the implementation makes written down where the next reader
will hit them? An assumption that only exists in the implementer's head is a 1
here even if the code is perfect. Where a decision went against the obvious
choice, the reason is recorded in one line.

## Scoring & pass line

Weighted average = `Σ(weight × score) / Σ(weight)`, computed by
`score-task.ts` — never by hand.

- **Pass threshold**: `> 4.0` on every task in this plan.
- **Hard fail**: `Correctness < 4` vetoes the task regardless of the average.

The weights are per task, and every task in this plan uses the same set — with
one deliberate exception, below.

| Dimension               | Weight |
| ----------------------- | ------ |
| Correctness             | 3      |
| Backward compatibility  | 2      |
| Test coverage           | 2      |
| Interface & readability | 1      |
| Assumptions & docs      | 1      |

## The closing review is scored on different axes

The plan's final-review task does **not** use the table above, and does not use
the `Correctness < 4` veto. It scores the whole deliverable, not one task's
code, so re-running the per-task dimensions there would only re-score work its
own rubric already gated.

Its table is:

| Dimension                     | Weight |
| ----------------------------- | ------ |
| Integration — does it compose | 3      |
| Meets the goal                | 3      |
| No regressions                | 2      |
| Consistency                   | 2      |
| Leanness                      | 1      |

Its veto is `Meets the goal < 4`. Its threshold stays `> 4.0` on the same 0–5
scale, and the scale and the general meaning of a band are unchanged.

**Leanness** exists only there because only the whole diff reveals accumulated
over-engineering: each task looks proportionate on its own. Score the judgement,
never a line count — a plan that legitimately adds a lot of code still scores
well on it.
