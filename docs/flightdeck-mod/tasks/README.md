# flightdeck-mod — Task System

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

Start with `data/01-deck-snapshot-cli.md`. It creates `packages/dispatch/hooks/flightdeck/types.ts`, the `DeckSnapshot` contract every later task imports.

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
| data | 01 | Deck snapshot CLI | todo | > 4 | — |
| mod | 01 | Pane layout rows | todo | > 4 | data/01 |
| mod | 02 | Flightdeck pane mod | todo | > 4 | data/01, mod/01 |
| mod | 03 | Docs for the pane | todo | > 4 | mod/02 |
| review | 01 | Final review | todo | > 4 | data/01, mod/01, mod/02, mod/03 |

## Dependency graph

```
data/01
├─→ mod/01
├─→ mod/02 *
│   └─→ mod/03
└─→ review/01 *
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| review/01 | data/01, mod/01, mod/02, mod/03 |
| mod/01 | data/01 |
| mod/02 | data/01 |
<!-- flightplan:generated:end -->

## Known gaps

- **Static-depth waves are the plan's shape, not the run's history.** Autopilot can split a wave under Max parallel and re-fly a task inside its wave, so `wave N of M` can disagree with the scout's `scout-wave-N` labels. Accepted for stable rows.
- **The auto-open matcher keys on the string `flightdeck.ts`.** Renaming the launcher silently stops auto-open; the `deck-command` tests pin the autopilot and deckplan forms.
- **The Open flightdeck button inherits the launcher's global `daemon.json`.** Opening a different plan SIGTERMs the running server.
- **Three `(human)` checks are owed after the run:** the docked pane, the inline layout, and auto-open on a real `/autopilot` launch.
