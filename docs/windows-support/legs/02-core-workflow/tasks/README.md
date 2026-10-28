# 02-core-workflow — Task System

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

Start with the four foundation tasks in parallel: `chronicle/01-test-env.md`, `dispatch/01-test-env.md`, `guard/01-test-env.md`, `relay/01-test-env.md` (plus `platform/03-docs.md`, which depends on nothing). By hand, take `dispatch/01-test-env.md` first: dispatch is the longest chain.

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
| chronicle | 01 | Honest chronicle tests on Windows | todo | > 4 | — |
| chronicle | 02 | Fix chronicle's Windows product bugs | todo | > 4 | chronicle/01 |
| chronicle | 03 | Codex home fallback on Windows | todo | > 4 | chronicle/01 |
| dispatch | 01 | Honest dispatch tests on Windows | todo | > 4 | — |
| dispatch | 02 | Windows path handling in dispatch | todo | > 4 | dispatch/01 |
| dispatch | 03 | Spawn safety and worktrees on Windows | todo | > 4 | dispatch/02 |
| guard | 01 | Honest guard tests on Windows | todo | > 4 | — |
| guard | 02 | Fix guard's Windows product bugs | todo | > 4 | guard/01 |
| platform | 01 | OpenCode layer on Windows | todo | > 4 | dispatch/02 |
| platform | 02 | CI required suites and smoke job | todo | > 4 | chronicle/02, chronicle/03, dispatch/03, guard/02, relay/02, platform/01 |
| platform | 03 | Windows docs for the core plugins | todo | > 4 | — |
| relay | 01 | Honest relay tests on Windows | todo | > 4 | — |
| relay | 02 | Fix relay's Windows product bugs | todo | > 4 | relay/01 |
| review | 01 | Final review 🏁 | todo | > 4 | platform/02, platform/03 |

## Dependency graph

```
chronicle/01
├─→ chronicle/02
│   └─→ platform/02 *
│       └─→ review/01 *
└─→ chronicle/03
dispatch/01
└─→ dispatch/02
    ├─→ dispatch/03
    └─→ platform/01
guard/01
└─→ guard/02
platform/03
relay/01
└─→ relay/02
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| platform/02 | chronicle/02, chronicle/03, dispatch/03, guard/02, relay/02 |
| platform/01 | dispatch/02 |
| review/01 | platform/02, platform/03 |
<!-- flightplan:generated:end -->

## Known gaps

- Autopilot verifies each task on macOS only. Windows correctness shows when the leg's PR runs CI; a red Windows job adds tasks to this leg before it lands.
- Real-PC runs of the agent-driven flows (`/chronicle:commit`, `/chronicle:release`, `/dispatch:flightplan` + `/autopilot`, the guard reviewer) and a WSL browser open are owed human checks in the final review.
- Where Claude Code's Write tool puts `/tmp/q-lab/...` on native Windows is unknown; agent prompts naming that path stay unchanged this leg.
- The opencode `-f` file fallback still passes a path in argv. A Windows profile whose temp path holds `&`, `%` or another `.cmd`-special character makes Bun refuse it. It applies only when the stdin probe fails.
