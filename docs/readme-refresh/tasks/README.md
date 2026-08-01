# readme-refresh — Task System

## Purpose

Each task file is a **self-contained, independently pickable unit**. An executor needs only:

1. The `_context/` files listed in the task's `Required reading` header
2. The task file itself

They should not need to open `PLAN.md` or any other task file. `PLAN.md` is the master spec; `_context/`
is its surgical extract; task files describe **what to do** without re-explaining **why**.

## Directory layout

```
tasks/
├── README.md                  ← this file
├── _context/
│   ├── shared.md              ← repo facts, README structure, writing rules
│   └── rubric.md              ← the shared graded bar
├── readme/                    ← the content edits (strictly serial — same file)
└── integration/               ← the closing whole-file gate
```

## Reading order for executors

1. `_context/shared.md` — required for every task.
2. `_context/rubric.md` — the graded bar.
3. The task file itself.

## Naming convention

`<bucket>/NN-<kebab-slug>.md` — `NN` is two-digit zero-padded.

## Where to start

`readme/01-chronicle-section.md`. There is one root and one chain: every task in this tree edits
`README.md`, so nothing here parallelizes. Two agents editing the same file at once conflict.

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
| integration | 01 | final review | todo | > 4 | readme/02 |
| readme | 01 | chronicle section | todo | > 4 | — |
| readme | 02 | installation coverage and skill counts | todo | > 4 | readme/01 |

## Dependency graph

```
readme/01
└─→ readme/02
    └─→ integration/01
```

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| integration/01 | readme/02 |
<!-- flightplan:generated:end -->

## Known gaps

Recorded deliberately. Neither blocks execution.

1. **Docs-only, so no test suite runs.** The gates are `grep` checks with stated expected counts. That
   is the smallest honest check for prose, and it cannot catch a section that is well-formed but badly
   written. The final review is the countermeasure.
2. **No fan-out.** The serial chain exercises the wave loop three times over but never runs two tasks
   concurrently.
