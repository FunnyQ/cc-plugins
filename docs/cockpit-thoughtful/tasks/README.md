# cockpit-thoughtful — Task System

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

| Bucket  | NN  | Title                                   | Status | Pass line | Depends on                   |
| ------- | --- | --------------------------------------- | ------ | --------- | ---------------------------- |
| backend | 01  | Scribe CLI and schema                   | todo   | > 4       | —                            |
| release | 01  | Version bump and changelog              | todo   | > 4       | backend/01, skills/02, ui/01 |
| release | 02  | Final review                            | todo   | > 4       | release/01                   |
| skills  | 01  | cockpit-scribe skill                    | todo   | > 4       | backend/01                   |
| skills  | 02  | thoughtful skill                        | todo   | > 4       | skills/01                    |
| ui      | 01  | Dashboard kind, source, and empty-state | todo   | > 4       | backend/01                   |

## Dependency graph

```
backend/01
├─→ release/01 *
│   └─→ release/02
├─→ skills/01
│   └─→ skills/02
└─→ ui/01
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task       | Depends on                   |
| ---------- | ---------------------------- |
| ui/01      | backend/01                   |
| release/01 | backend/01, skills/02, ui/01 |
| skills/01  | backend/01                   |

<!-- flightplan:generated:end -->

## Known gaps

<!-- Human-authored. List unresolved decisions or upstream blockers here. -->
