# flightdeck-workflow-contract — Task System

## Purpose

Each task file is a **self-contained, independently pickable unit**. An executor needs only:

1. The `_context/` files listed in the task's `Required reading` header
2. The task file itself

They should not need to open `PLAN.md` or any other task file. `PLAN.md` is the master spec; `_context/` is its surgical extract; task files describe **what to do** without re-explaining **why**.

## Directory layout

```
tasks/
├── README.md                  ← this file
├── _context/                  ← shared context (every task references these)
│   ├── shared.md              ← decisions, conventions, commit style
│   └── <other>.md             ← topic-specific shared context
└── <bucket>/                  ← bucket description
    └── NN-<slug>.md
```

## Reading order for executors

1. `_context/shared.md` — required for every task.
2. Topic-specific `_context/*.md` per the task's `Required reading` header.
3. The task file itself.

## Naming convention

`<bucket>/NN-<kebab-slug>.md` — `NN` is two-digit zero-padded.

## Where to start

Start with `contract/01-state-entry-kind.md`. It is the only task with no
dependencies, so the first wave is exactly one task.

`contract/02-graph-node-type.md` follows it, and the ordering between them is
worth knowing: the second does not consume the first's output. They are
sequenced because both edit `fleet.ts` and its test, and a wave dispatches every
ready task into one shared working tree with no task allowed to commit — so two
tasks editing one file in the same wave overwrite each other. That constraint
shaped the tree; do not "optimise" it back into parallel.

Read `_context/contract.md` before either. It is the single thing every task in
this plan agrees on, and both foundation tasks change code the rest of the tree
builds against.

<!-- flightplan:generated:start -->

## Status conventions

Each task header has a `> **Status**: <status>` line. Executors update it as they go:

- `todo` — not started
- `in-progress` — actively being worked on
- `done` — merged / shipped
- `blocked` — waiting on a decision, upstream task, or external resource

## Task index

| Bucket   | NN  | Title                                                   | Status | Pass line | Depends on                     |
| -------- | --- | ------------------------------------------------------- | ------ | --------- | ------------------------------ |
| contract | 01  | Add the state entry kind to the flightlog               | todo   | > 4       | —                              |
| contract | 02  | Extract the narrow GraphNode type                       | todo   | > 4       | contract/01                    |
| contract | 03  | Write the graph contract specification                  | todo   | > 4       | contract/01, contract/02       |
| deck     | 01  | Read and validate graph.json                            | todo   | > 4       | contract/02, contract/03       |
| deck     | 02  | Derive node state from the event trail                  | todo   | > 4       | contract/01, deck/01           |
| deck     | 03  | Auto-detect the source and route both APIs to it        | todo   | > 4       | deck/01, deck/02               |
| deck     | 04  | Honor the declared repo root when locating transcripts  | todo   | > 4       | deck/01, deck/03               |
| deck     | 05  | Honor declared lane order in the dependency graph       | todo   | > 4       | deck/03                        |
| review   | 01  | Final review                                            | todo   | > 4       | contract/03, deck/04, skill/02 |
| skill    | 01  | The deckplan authoring reference                        | todo   | > 4       | contract/03                    |
| skill    | 02  | The runnable example, doubling as the dashboard fixture | todo   | > 4       | skill/01, deck/04, deck/05     |

## Dependency graph

```
contract/01
├─→ contract/02
│   └─→ deck/01 *
│       ├─→ deck/03 *
│       │   └─→ deck/05
│       └─→ deck/04 *
├─→ contract/03 *
│   ├─→ review/01 *
│   └─→ skill/01
│       └─→ skill/02 *
└─→ deck/02 *
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task      | Depends on                     |
| --------- | ------------------------------ |
| skill/01  | contract/03                    |
| skill/02  | deck/04, deck/05               |
| review/01 | contract/03, deck/04, skill/02 |
| deck/02   | contract/01                    |
| deck/01   | contract/02, contract/03       |

<!-- flightplan:generated:end -->

## Known gaps

- **The prompt-text join is proven; the out-of-repo path is not.** A real
  Workflow run of three agents was executed against a scratch run directory
  _inside_ the repository, with prompts following the announce convention this
  plan specifies. All three transcripts were discovered, all three parsed their
  node, role, and attempt out of the prompt, and all three joined to their fleet
  row with real token figures. So the convention works, and the authoring rules
  built on it are sound.

  The same trail copied to a directory _outside_ any repository found zero
  transcripts and reported a run that spent nothing — no error, no warning. That
  is the failure the transcript-anchoring task exists to remove, now measured
  rather than predicted. It stays a gap only because the fix is not written yet;
  re-run the same check once it is.

- **The `null`-versus-`"todo"` status question is specified but not yet
  decided.** The existing state ladder tests for the literal string `"todo"`,
  while a freshly loaded contract node carries `null`. The state-derivation task
  requires whoever implements it to pick a side deliberately and record which.
  Getting it wrong makes every unstarted node read as blocked, and the panel
  shows a run that cannot start.

- **The per-run identifier is unproven under a live re-run.** The mechanism —
  a `run.id` beside the graph, interpolated into every prompt, re-read per
  snapshot — is specified and unit-testable, but the case it exists for is a
  workflow that fails and is re-run while a dashboard is connected. Fixtures can
  prove the filter; only a real re-run proves the whole loop.

  The problem it solves is not in doubt: the membership test carries no run
  discriminator at all today, so every transcript mentioning the run directory
  matches, whichever run produced it. The verification run above confirmed
  membership works; nothing in that path distinguishes one run from the next.

- **A `dispatch` version bump is not part of this plan.** It belongs to a
  separate release flow once this ships.

### Recorded by the final review (review/01)

Two gaps above are now stale in one direction. The out-of-repo transcript walk
has its fix — `repoRoot` comes from `graph.json` and is unit-tested — and the
per-run identifier is implemented and unit-tested. Neither was re-measured
against a live run, because executing one is out of scope for this plan. Read
both as "implemented, not field-proven".

Findings this review examined and deliberately did not apply:

- **`NodeValidity` stays looser than `TaskValidity`.** `graph-node.ts` declares
  `status: string | null` and `rule: string` where `parse-task.ts` has
  `Exclude<TaskStatus, "done">` and `"status" | "completion-state"`. Left as is:
  no consumer reads either field as a discriminant — `deriveTaskViews` reads only
  `kind` and `reason` — so the looser fields cost nothing today, while tightening
  them forces edits to three existing assertions, one of which deliberately proves
  an arbitrary status string is inert.

- **`detectSource` keeps its `try`/`catch` instead of `statSync(..., {
throwIfNoEntry: false })`.** The stdlib option was applied and reverted: it
  suppresses only `ENOENT`, so a `--plan` pointing at a plain file threw
  `ENOTDIR` and lost the launcher's validation message. A pre-existing test
  caught it. The `catch` is load-bearing, not a hand-rolled stdlib duplicate.

- **`graph.js` keeps its `options.lanes?.length && Array.isArray(nodes)`
  ternary.** Simplifying it to `orderedNodes` was applied and reverted: the
  `appends undeclared buckets in input order` test pins that iteration order for
  a payload that declares lanes and still carries an undeclared bucket. Unused by
  the graph loader, but covered behaviour on the task-tree path.

- **`buildStateEntry` stays.** It is an identity mapping with one caller, but it
  keeps the CLI's `log` and `state` branches symmetric with `buildNoteEntry`
  beside it, and removing it would delete a passing test for no behaviour change.

- **`roleFromEntry`'s `entry.kind === "state"` guard stays.** `aggregateFleet`
  returns on state entries before reaching it, but the guard is the narrowing
  that lets `entry.role` type-check; removing it needs a new parameter type, so
  it is not a net reduction.

- **`SKILL.md`'s nine short-form rules stay.** They restate `authoring.md`
  §1–9, but `SKILL.md` is the always-loaded surface and the reference is opt-in;
  collapsing them to a pointer makes the skill's behaviour depend on the model
  choosing to open a file.

- **The formatter reflowed whole files.** The repo's `PostToolUse` hook
  reformats each edited file, so `graph-source.ts`, `graph-source.test.ts`, and
  several others show far larger diffs than this review's changes. Read those
  diffs with `git diff -w`.
