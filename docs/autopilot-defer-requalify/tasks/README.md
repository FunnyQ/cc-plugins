# autopilot-defer-requalify — Task System

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

`work/01-restore-family-ban.md`. It is the only task with no dependencies, and it is prompt
text only — no control flow, no schema.

The chain `01 → 02 → 03` is strictly sequential: all three edit the same fenced script, and
`01`'s injection into the verifier prompt lands in the exact region `03` rewrites. Only `04`
and `05` may share a wave.

<!-- flightplan:generated:start -->
## Status conventions

Each task header has a `> **Status**: <status>` line. Executors update it as they go:

- `todo` — not started
- `in-progress` — actively being worked on
- `done` — merged / shipped
- `blocked` — waiting on a decision, upstream task, or external resource

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| work | 01 | Restore-family ban across every command-discretion prompt | todo | > 4 | — |
| work | 02 | Wave tree-watch and writer accounting | todo | > 4 | work/01 |
| work | 03 | Defer-and-requalify gate layer | todo | > 4 | work/02 |
| work | 04 | Requalify rows in the fleet dashboard | todo | > 4 | work/03 |
| work | 05 | Design notes for the restore ban and the defer gate | todo | > 4 | work/03 |
| work | 06 | Final review | todo | > 4 | work/04, work/05 |

## Dependency graph

```
work/01
└─→ work/02
    └─→ work/03
        ├─→ work/04
        │   └─→ work/06 *
        └─→ work/05
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.
<!-- flightplan:generated:end -->

## Known gaps

- **A postponement is granted on a moment, not a lease.** A sibling can begin a dev retry the
  instant after the writer count crosses zero and releases a waiter, so the follow-up check can
  still meet a dirty tree. It then fails strictly — which is the pre-existing behaviour, never
  worse. Removing this would need a write lease across agents, which the Workflow model cannot
  express. Deliberate; do not "fix" it by widening what a verifier may waive.
- **A deferral proves concurrency, never causation.** The guard proves some *other* task was
  writing; it cannot prove that task caused the failure. The strict re-run is what makes a
  wrong attribution cheap rather than dangerous.
- **Whole-suite gates on tasks that share a wave remain unsatisfiable-by-luck.** A criterion
  like `cargo test passes` on a task dispatched in parallel is an authoring defect, and it
  belongs to the planning skill's linter, not to this plan. This work makes the symptom
  survivable; it does not make such gates correct.
- **The ban is defense-in-depth, not enforcement.** Workflow `agent()` accepts no tool
  allowlist, so nothing structurally prevents a destructive git call — the prompt is the only
  lever inside the script. Do not grade the deliverable against "an agent can no longer do
  this"; grade it against "no prompt permits it".
- **`work/03` is deliberately the largest task in the tree, and review flagged its size.** It
  carries the gate schema, the prompt modes, the guard predicate, the control flow and its own
  test matrix. Splitting the mechanism from its tests was considered and rejected: the halves
  are one coherent unit, and a test-only task cannot be verified on its own. The mechanism /
  decision seam between the tree-watch task and this one is where the split was already made,
  and it was chosen deliberately. If it does prove too large in execution, split it at the
  guard predicate — mechanism plus the defer/retry path first, the four-guard matrix and the
  writer-accounting cases second — rather than by peeling off the tests.
