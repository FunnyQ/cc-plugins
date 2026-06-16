# chronicle — Task System

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
| commit | 01 | Port analyze-changes script | todo | > 4.2 | — |
| commit | 02 | Commit message template | todo | > 4.2 | — |
| commit | 03 | Commit skill (unified decision tree) | todo | > 4.2 | commit/01, commit/02 |
| packaging | 01 | Manifests and marketplace registries | todo | > 4.2 | commit/03, pr/03 |
| packaging | 02 | Changelog and repo docs | todo | > 4.2 | packaging/01 |
| packaging | 03 | Final review | todo | > 4.2 | commit/01, commit/02, commit/03, pr/01, pr/02, pr/03, packaging/01, packaging/02 |
| pr | 01 | analyze-branch script | todo | > 4.2 | — |
| pr | 02 | request-creator script | todo | > 4.2 | — |
| pr | 03 | PR skill (history + cockpit → reviewer-legible PR/MR) | todo | > 4.2 | pr/01, pr/02 |

## Dependency graph

```
commit/01
├─→ commit/03 *
│   └─→ packaging/01 *
│       └─→ packaging/02
└─→ packaging/03 *
commit/02
pr/01
└─→ pr/03 *
pr/02
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| packaging/01 | commit/03, pr/03 |
| packaging/03 | commit/01, commit/02, commit/03, pr/01, pr/02, pr/03 |
<!-- flightplan:generated:end -->

## Known gaps

<!-- Human-authored. List unresolved decisions or upstream blockers here. -->
