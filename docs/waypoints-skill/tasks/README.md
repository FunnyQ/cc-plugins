# waypoints-skill — Task System

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

<!-- Edit this with the first task to pick up, e.g. `ui/01-fixture-shell.md`. -->

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
| integration | 01 | flightplan waypoint mode + lint-hook widen | todo | > 4 | scripts/01, scripts/02 |
| integration | 02 | dispatch plugin metadata bump | todo | > 4 | skill/01, integration/01 |
| integration | 03 | final review | todo | > 4 | scripts/01, scripts/02, skill/01, integration/01, integration/02 |
| scripts | 01 | waypoints CLI core (parse · active · leg-scaffold) | todo | > 4 | — |
| scripts | 02 | waypoints advance verb | todo | > 4 | scripts/01 |
| skill | 01 | waypoints skill and references | todo | > 4 | scripts/01, scripts/02 |

## Dependency graph

```
scripts/01
├─→ integration/01 *
├─→ integration/03 *
├─→ scripts/02
└─→ skill/01 *
    └─→ integration/02 *
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| skill/01 | scripts/01, scripts/02 |
| integration/02 | skill/01 |
| integration/03 | scripts/01, scripts/02, skill/01 |
| integration/01 | scripts/01, scripts/02 |
<!-- flightplan:generated:end -->

## Known gaps

<!-- Human-authored. List unresolved decisions or upstream blockers here. -->

- The **Cross-bucket dependencies** table above is cross-bucket-only by generator design, so same-bucket
  edges (`integration/02 → integration/01`, `integration/03 → integration/01, integration/02`) are not
  shown there. The **Task index** carries each task's full direct `Depends on` — treat it as authoritative,
  and use `next-ready.ts` (which reads the task-file headers) for execution ordering.
