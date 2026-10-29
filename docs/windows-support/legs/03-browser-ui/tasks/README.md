# 03-browser-ui — Task System

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

Start with `browsers/01-test-env.md`. The independent foundations `runes/01-portable-test-contracts.md` and `herdr/01-test-env.md` are also ready. Read each task's Required reading before executing.

Execute the complete tree with `/dispatch:autopilot docs/windows-support/legs/03-browser-ui`. This plan is approved; all 11 tasks are still todo.

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
| browsers | 01 | Repair portable browser test fixtures. | todo | > 4 | — |
| browsers | 02 | Support native browser discovery and lifecycle. | todo | > 4 | browsers/01 |
| browsers | 03 | Require native browser smoke coverage. | todo | > 4 | browsers/02 |
| herdr | 01 | Repair Windows test path assumptions. | todo | > 4 | — |
| herdr | 02 | Support Windows ask and browser CLI boundaries. | todo | > 4 | herdr/01 |
| platform | 01 | Gate browser and UI portability in CI. | todo | > 4 | browsers/03, runes/03, herdr/02 |
| platform | 02 | Document support boundaries and owed checks. | todo | > 4 | platform/01 |
| review | 01 | Verify integrated browser and UI portability. | todo | > 4 | platform/02 |
| runes | 01 | Separate portable contracts from mod tests. | todo | > 4 | — |
| runes | 02 | Open and retain runes artifacts across platforms. | todo | > 4 | runes/01 |
| runes | 03 | Port the explain checker off macOS. | todo | > 4 | runes/02 |

## Dependency graph

```
browsers/01
└─→ browsers/02
    └─→ browsers/03
        └─→ platform/01 *
            └─→ platform/02
                └─→ review/01
herdr/01
└─→ herdr/02
runes/01
└─→ runes/02
    └─→ runes/03
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| platform/01 | browsers/03, runes/03, herdr/02 |
| review/01 | platform/02 |
<!-- flightplan:generated:end -->

## Known gaps

- Native Windows supports Chrome only; Firefox and Zen refuse there. WSL uses Linux-installed browsers only. Both are deferred to a later leg.
- Three-OS Bun contracts do not prove the full runes mod works on those OS; run the complete local mod suite separately.
- Native Windows/WSL UI, panes and Zen remain owed until actual evidence is recorded in `../OWED-CHECKS.md` during implementation.
- Local planning has not run remote implementation CI. The implementation PR must supply three-OS required/smoke evidence.

## Planning review

Codex drafted the tree through two design passes and six tree passes (Standard tier). A follow-up review on 2026-10-29 cut scope back to the roadmap goal:

- Removed the WSL-to-Windows browser fallback task; WSL now uses Linux browsers only.
- Limited native Windows to Chrome; Firefox and Zen refuse there.
- Reduced the explain checker task to six portability changes and dropped its job/lock/cancel lifecycle, which addressed a timeout race that exists on every OS.
- Added the minimap and teacher `HOME` readers to the runes platform task.
