# cockpit-autolog — Task System

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

| Bucket   | NN  | Title                                                    | Status | Pass line | Depends on                                                                                                       |
| -------- | --- | -------------------------------------------------------- | ------ | --------- | ---------------------------------------------------------------------------------------------------------------- |
| backend  | 01  | Global log_language config module                        | todo   | > 4       | —                                                                                                                |
| backend  | 02  | `cockpit config` CLI subcommand                          | todo   | > 4       | backend/01                                                                                                       |
| backend  | 03  | Retire `start`, strip goal machinery from the CLI kernel | todo   | > 4       | backend/02                                                                                                       |
| backend  | 04  | Strip goal readers from registry + project-info          | todo   | > 4       | backend/03                                                                                                       |
| docs     | 01  | Update CLAUDE.md + CHANGELOG                             | todo   | > 4       | backend/03, backend/04, frontend/01, skills/01, skills/02, skills/03, skills/04                                  |
| docs     | 02  | Final review — whole-system gate                         | todo   | > 4       | backend/01, backend/02, backend/03, backend/04, frontend/01, skills/01, skills/02, skills/03, skills/04, docs/01 |
| frontend | 01  | Remove goal rendering from the dashboard                 | todo   | > 4       | backend/03                                                                                                       |
| skills   | 01  | Thin SKILL.md router + pilot reference                   | todo   | > 4       | backend/02, backend/03, skills/02                                                                                |
| skills   | 02  | Scribe reference + delete the cockpit-scribe skill       | todo   | > 4       | backend/02                                                                                                       |
| skills   | 03  | Thoughtful command + delete the thoughtful skill         | todo   | > 4       | skills/01, skills/02                                                                                             |
| skills   | 04  | SessionStart hook that auto-enables thoughtful (Claude)  | todo   | > 4       | skills/03                                                                                                        |

## Dependency graph

```
backend/01
├─→ backend/02
│   ├─→ backend/03
│   │   ├─→ backend/04
│   │   ├─→ docs/01 *
│   │   └─→ frontend/01
│   ├─→ skills/01 *
│   │   └─→ skills/03 *
│   │       └─→ skills/04
│   └─→ skills/02
└─→ docs/02 *
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task        | Depends on                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| frontend/01 | backend/03                                                                                              |
| docs/02     | backend/01, backend/02, backend/03, backend/04, frontend/01, skills/01, skills/02, skills/03, skills/04 |
| docs/01     | backend/03, backend/04, frontend/01, skills/01, skills/02, skills/03, skills/04                         |
| skills/02   | backend/02                                                                                              |
| skills/01   | backend/02, backend/03                                                                                  |

<!-- flightplan:generated:end -->

## Known gaps

<!-- Human-authored. List unresolved decisions or upstream blockers here. -->
