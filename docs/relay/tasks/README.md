# relay — Task System

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
| backends | 01 | Capability gate | todo | > 4 | core/01 |
| backends | 02 | Codex backend | todo | > 4 | core/01 |
| backends | 03 | OpenCode backend | todo | > 4 | core/01 |
| backends | 04 | Claude backend | todo | > 4 | core/01 |
| backends | 05 | Relay entry point | todo | > 4 | backends/01, backends/02, backends/03, backends/04, core/03 |
| core | 01 | Types and shared utilities | todo | > 4 | — |
| core | 02 | Context collector | todo | > 4 | — |
| core | 03 | Relay prompt builder | todo | > 4 | core/01, core/02 |
| package | 01 | SKILL.md and references | todo | > 4 | backends/05 |
| package | 02 | Manifests and marketplace registration | todo | > 4 | backends/05 |
| package | 03 | Changelog and repo docs | todo | > 4 | package/02 |
| package | 04 | Backend alias commands | todo | > 4 | package/01 |
| package | 99 | Final review | todo | > 4 | core/01, core/02, core/03, backends/01, backends/02, backends/03, backends/04, backends/05, package/01, package/02, package/03, package/04 |

## Dependency graph

```
core/01
├─→ backends/01
│   └─→ backends/05 *
│       ├─→ package/01
│       │   └─→ package/04
│       └─→ package/02
│           └─→ package/03
├─→ backends/02
├─→ backends/03
├─→ backends/04
├─→ core/03 *
└─→ package/99 *
core/02
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| backends/02 | core/01 |
| backends/01 | core/01 |
| backends/03 | core/01 |
| backends/05 | core/03 |
| backends/04 | core/01 |
| package/02 | backends/05 |
| package/01 | backends/05 |
| package/99 | core/01, core/02, core/03, backends/01, backends/02, backends/03, backends/04, backends/05 |
<!-- flightplan:generated:end -->

## Known gaps

<!-- Human-authored. List unresolved decisions or upstream blockers here. -->
