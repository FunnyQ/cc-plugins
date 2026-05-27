# permission-relay — Task System

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

<!-- probe-deep:generated:start -->
## Status conventions

Each task header has a `> **Status**: <status>` line. Executors update it as they go:

- `todo` — not started
- `in-progress` — actively being worked on
- `done` — merged / shipped
- `blocked` — waiting on a decision, upstream task, or external resource

## Task index

| Bucket | NN | Title | Status | Depends on |
|---|---|---|---|---|
| backend | 01 | Permission broker module | todo | — |
| backend | 02 | Wire permission routes into the daemon | todo | backend/01 |
| channel | 01 | Channel permission relay | todo | backend/01 |
| ui | 01 | Permission modal | todo | backend/01 |
| ui | 02 | Attention — notification, title flash, badge | todo | ui/01 |

## Dependency graphs

### `backend/`

```
backend/01  <-  (start)
backend/02  <-  backend/01
```

### `channel/`

```
channel/01  <-  (start)
```

### `ui/`

```
ui/01  <-  (start)
ui/02  <-  ui/01
```

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| ui/01 | backend/01 |
| channel/01 | backend/01 |
<!-- probe-deep:generated:end -->

## Known gaps

<!-- Human-authored. List unresolved decisions or upstream blockers here. -->
