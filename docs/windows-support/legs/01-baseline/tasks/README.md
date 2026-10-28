# 01-baseline — Task System

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

Start with `monitor/01-hook-entry.md` and `platform/01-line-endings.md`; they are independent. `platform/03-windows-docs.md` can run beside them.

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
| monitor | 01 | Hook entry | todo | > 4 | — |
| platform | 01 | Line endings | todo | > 4 | — |
| platform | 02 | CI workflow | todo | > 4 | platform/01, monitor/01 |
| platform | 03 | Windows docs | todo | > 4 | — |
| review | 01 | Final review | todo | > 4 | platform/02, platform/03 |

## Dependency graph

```
monitor/01
platform/01
└─→ platform/02 *
    └─→ review/01 *
platform/03
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| platform/02 | monitor/01 |
| review/01 | platform/02, platform/03 |
<!-- flightplan:generated:end -->

## Known gaps

- The `report` CI tier is advisory. A regression in a suite outside the blocking tier shows only in the step summary. The final review's before/after run covers macOS; Linux relies on reading the ubuntu summary.
- Unverified: whether setting `CLAUDE_CODE_GIT_BASH_PATH` to a missing path makes Claude Code fall back to PowerShell for hooks. The final review's human check answers it.
- The final review's rubric vetoes only on `No regressions`; `Meets the leg goal` has no veto of its own. A result that works under Git Bash alone still cannot pass, because the human Windows checks are gate items and stay unticked.
- Unverified until the final review's human check: whether other plugins' hooks or mods print errors on native Windows. A new error there fails the final review and becomes a new task in this leg; it is never banked here.
