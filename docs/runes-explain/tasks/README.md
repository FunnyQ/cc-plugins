# runes-explain — Task System

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

Start with `core/01-config-and-state.md`, `core/02-fork-protocol.md` and `html/01-template-and-writer.md`; all three
have no dependencies and run in parallel.

Commit `docs/runes-explain/` before the first task runs: the final review measures the feature diff from the
commit that added `tasks/_context/protocol.md`.

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
| core | 01 | config-and-state | todo | > 4 | — |
| core | 02 | fork-protocol | todo | > 4 | — |
| core | 03 | orchestrator | todo | > 4 | core/01, core/02, html/01, html/02 |
| docs | 01 | claude-md | todo | > 4 | ui/01, ui/02 |
| html | 01 | template-and-writer | todo | > 4 | — |
| html | 02 | layout-checker | todo | > 4 | core/01, html/01 |
| review | 01 | final review | todo | > 4 | docs/01 |
| ui | 01 | band-button | todo | > 4 | core/03 |
| ui | 02 | explain-pane | todo | > 4 | core/03 |

## Dependency graph

```
core/01
├─→ core/03 *
│   ├─→ ui/01
│   │   └─→ docs/01 *
│   │       └─→ review/01
│   └─→ ui/02
└─→ html/02 *
core/02
html/01
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| ui/01 | core/03 |
| ui/02 | core/03 |
| core/03 | html/01, html/02 |
| html/02 | core/01 |
| docs/01 | ui/01, ui/02 |
| review/01 | docs/01 |
<!-- flightplan:generated:end -->

## Known gaps

- A fork on a lapsed cache bills the whole prefix at the main model's price; the pane shows the cost after, nothing
  prevents it.
- Whether a button press counts as an asked pane (seats below 144 columns) is unverified; the orchestrator toasts
  when `isPlaced` is false.
- A checker that never answers shows `timed out` at the next turn end after 180 s, not at 180 s: timers carry no
  `$`, so expiry is lazy.
- `generatedAt` follows the mock's masthead format (`25 Oct 2026 · 14:32`); no requirement fixed it.
