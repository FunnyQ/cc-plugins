# REVIEW-01: Final review

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/03, deck/04, skill/02
> **Status**: done
> **Final review**: true

## Goal

The whole deliverable holds together: a workflow author can follow the shipped
documentation all the way to a rendering dashboard, and the existing task-tree
path is provably unregressed.

## Files to create / modify

Every edit here is a **fix**, scoped to a defect this review finds. This task
writes nothing new of its own except the known-gaps list.

- `packages/dispatch/skills/autopilot/scripts/` (modify) — fix-only edits to the
  server modules the plan changed: the graph loader, the narrow node type, the
  fleet derivation, the tree payload, the launcher, the route table, and the
  transcript source
- `packages/dispatch/skills/flightplan/scripts/` (modify) — fix-only edits to
  the shared event-trail library and its CLI
- `packages/dispatch/skills/autopilot/references/graph-contract.md` (modify) —
  fix-only edits to the specification
- `packages/dispatch/skills/deckplan/` (modify) — fix-only edits to the
  authoring skill and its runnable example
- `packages/dispatch/skills/autopilot/dashboard/dist/modules/graph.js`,
  `packages/dispatch/skills/autopilot/dashboard/dist/modules/graph.test.js`, and
  `packages/dispatch/skills/autopilot/dashboard/dist/app.js` (modify) — fix-only edits
  to the declared-lane-order path. These are the plan's one sanctioned frontend
  edit and they are delivered files like any other; without them a lane-order
  defect found here could only be recorded, not fixed. The visual language stays
  off limits even to this task
- `packages/dispatch/.claude-plugin/plugin.json` and
  `packages/dispatch/.codex-plugin/plugin.json` (modify) — fix-only edits to the
  descriptive copy the new skill's arrival changes. Neither enumerates skills
  functionally; do not add a key that would make one
- `docs/flightdeck-workflow-contract/tasks/README.md` (modify) — record every
  finding this review cannot fix within its own scope

## Implementation notes

This is the holistic gate. It does **not** re-score individual pieces of work —
each carried its own rubric and was judged against it. This gate catches what
only the assembled whole reveals: integration, consistency, regressions, and
whether the plan's goal was actually met.

Work through all six areas below. Each is a check with a pass condition, not a
topic to muse on.

### 1. Does the chain compose end to end?

Read the authoring documentation as someone who has never seen this plan and has
no access to the source. Follow it literally:

1. Declare a graph file.
2. Write a conforming workflow script.
3. Hand-write a trail.
4. Point the dashboard at the run directory.

Every step must be completable from what the documentation says. A step that
only works because you already know the implementation is a defect — record the
exact sentence that fails and fix the documentation, not your reading of it.

Pass condition: you reach a rendering dashboard without opening a source file.

### 2. Do the three descriptions of the format agree?

Three artifacts describe the same format:

- the specification at `packages/dispatch/skills/autopilot/references/graph-contract.md`
- the authoring guidance shipped in the `deckplan` skill
- the loader's actual validation in `packages/dispatch/skills/autopilot/scripts/graph-source.ts`

Compare them field by field. For every field in the graph file, confirm all
three agree on: whether it is required, what its default is, and what happens
when it is malformed. Do the same for every validation rule and for each entry
kind in the trail.

This is the defect class most likely to have survived per-task review, because
each artifact was internally consistent — nobody was in a position to compare
them until now.

Pass condition: a written field-by-field comparison with no disagreement, or
every disagreement fixed.

### 3. Is the state-resolution order implemented exactly once?

The design was to map the trail's declarations onto the two inputs the existing
state ladder already reads, so the ladder stays the single implementation.

Grep for a second one. A parallel ladder anywhere — in the loader, in the
payload builder, in the skill's example — is a defect **even if it currently
produces identical answers**, because two ladders drift and the drift is
invisible: both keep rendering.

Pass condition: exactly one place decides a node's displayed state.

### 4. Is the existing path unregressed?

The task-tree source must load, render, and attribute tokens exactly as it did
before this work started.

Run the full suite. Then do the check the suite cannot do for you: read the
diff of every existing test file and confirm no assertion was **deleted or
loosened** to accommodate the new path. A weakened assertion is a regression
disguised as a passing test, and it is the single cheapest way for this plan to
ship a silent break.

Pass condition: the suite passes, and every existing assertion is intact or
strengthened.

### 5. Does the silent-failure guard hold?

Token attribution failing looks identical, on the panel, to a run that spent
nothing. There is no error, no empty state, no warning — just zeroes that read
as truth.

Confirm a test proves the pre-existing behaviour still works, rather than a
reviewer having assumed it. Specifically: a run directory inside a repository
must still locate its transcripts through the original walk, and that must be
asserted, not inferred from the new path's tests passing.

Pass condition: a named test fails if the original attribution path breaks.

### 6. Leanness across the whole diff

Read the complete diff in one pass and look for accumulation:

- an abstraction with exactly one caller
- an option nobody sets
- a hand-rolled version of what the platform or the standard library already
  provides
- a type parameter, wrapper, or indirection introduced "for later"

Each piece of work looked proportionate on its own. Only the whole diff shows a
pile-up. Score the judgement, never a line count — work that legitimately needs
a lot of code is not a leanness failure.

Pass condition: every remaining abstraction has a named current requirement that
fails without it.

### Fixes are in scope

This task is the last writer. Apply the fixes it finds, then re-run the gates
below — its own verification is what covers those edits, because nothing runs
after it.

Anything it cannot fix within its own scope goes into the known-gaps list in
`docs/flightdeck-workflow-contract/tasks/README.md`, with one line naming the
defect and why it was left. A finding that is neither fixed nor recorded is the
one outcome this gate must never produce.

## Acceptance criteria

- [x] The authoring documentation was followed literally, end to end, without
      opening a source file, and reached a rendering dashboard.
- [x] A field-by-field comparison of the specification, the authoring guidance,
      and the loader's validation is written down, and every disagreement found
      is fixed.
- [x] Exactly one implementation decides a node's displayed state; any second
      one found has been removed.
- [x] The diff of every pre-existing test file was read, and no assertion was
      deleted or loosened.
- [x] A named test proves that a run directory inside a repository still
      locates its transcripts through the original walk.
- [x] The whole diff was read in one pass for leanness, and every remaining
      abstraction has a named current requirement.
- [x] The full test suite passes.
- [x] The typecheck prints nothing for the paths this plan touched.
- [x] Every finding is either fixed or recorded in the known-gaps list.

## Verification

- [x] `bun test packages/dispatch/skills/flightplan/scripts/` passes.
- [x] `bun test packages/dispatch/skills/autopilot/scripts/` passes.
- [x] `bun test packages/dispatch/skills/autopilot/dashboard/dist/modules/`
      passes.
- [x] `bunx --bun tsc --noEmit | grep packages/dispatch` prints nothing. The
      repo-wide run is **not** green — 86 pre-existing errors sit outside this
      plan's scope — so a clean result is an empty grep, never a zero count.
- [x] Start the dashboard against the shipped example's run directory with
      `bun packages/dispatch/skills/autopilot/scripts/flightdeck.ts --plan <example-run-dir>`
      and confirm every panel renders: the lane list, the dependency graph, the
      fleet table, and the counts.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Meets the goal < 4 is an automatic veto.

| Dimension      | Weight | 0–1 (fail)                                                 | 2–3 (below bar)                                                            | 4–5 (pass)                                                                   |
| -------------- | ------ | ---------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Integration    | ×3     | the documented path does not reach a rendering dashboard   | it reaches one, but a step needed knowledge the documentation never gave   | a stranger following the documentation literally gets a rendering dashboard  |
| Meets the goal | ×3     | a declared graph plus a trail does not render              | it renders, but a panel or a count is wrong or absent                      | every panel renders correctly from a declared graph and a hand-written trail |
| No regressions | ×2     | the existing suite fails, or an assertion was deleted      | the suite passes but an assertion was loosened to fit the new path         | the suite passes and every pre-existing assertion is intact or stronger      |
| Consistency    | ×2     | the three descriptions of the format contradict each other | they agree on the required fields but drift on defaults or error behaviour | all three agree field by field, rule by rule                                 |
| Leanness       | ×1     | abstractions with one caller, options nobody sets          | one or two speculative seams left in                                       | every abstraction has a named current requirement that fails without it      |

## Out of scope

- **Re-scoring individual pieces of work** — Deferred. Each carried its own
  rubric and was already judged against it. This gate scores the assembled
  whole, and re-litigating a passed score wastes the one pass that can see
  integration.
- **Executing a real workflow run** — Deferred. It spends real tokens and needs
  separate authorization from the plan's owner. Live token attribution
  therefore stays a known gap: the hand-written trail proves the panels render,
  but only a real run proves the prompt-text join holds end to end.
- **Cutting a plugin release** — Deferred. Version bumps and tags are a separate
  flow with its own gates, and bundling one into a review commit hides it.
