# autopilot-worktrees — Task System

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

Commit this plan tree on its own first, so the commit autopilot records as `baseRef` precedes all of this plan's work. Then start with `models/01-models-header.md` and `worktree/01-worktree-script.md`. They share no files, so wave 1 runs them in parallel.

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
| docs | 01 | Flightplan docs for Models and the narrowed Max parallel | todo | > 4 | models/01 |
| docs | 02 | Autopilot docs for worktrees, models, and cleanup | todo | > 4 | worktree/06 |
| models | 01 | Parse and lint the Models task header | todo | > 4 | — |
| models | 02 | Per-role model and effort map in the orchestrator | todo | > 4 | models/01 |
| review | 01 | Final review | todo | > 4 | docs/01, docs/02 |
| worktree | 01 | worktree.ts — create, land, rebase, sweep | todo | > 4 | — |
| worktree | 02 | Run each task pipeline in its own worktree | todo | > 4 | worktree/01, models/02 |
| worktree | 03 | Land results — conflict rebase and park | todo | > 4 | worktree/02 |
| worktree | 04 | Drift re-verify and its flightdeck and resume-point support | todo | > 4 | worktree/03 |
| worktree | 05 | Run-wide abort on leak, and single-task resume in worktrees | todo | > 4 | worktree/04 |
| worktree | 06 | Delete the sibling-interference machinery | todo | > 4 | worktree/05 |

## Dependency graph

```
models/01
├─→ docs/01
│   └─→ review/01 *
└─→ models/02
worktree/01
└─→ worktree/02 *
    └─→ worktree/03
        └─→ worktree/04
            └─→ worktree/05
                └─→ worktree/06
                    └─→ docs/02
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| worktree/02 | models/02 |
| docs/02 | worktree/06 |
| docs/01 | models/01 |
| review/01 | docs/01, docs/02 |
<!-- flightplan:generated:end -->

## Known gaps

- **Build-cache reuse is unmeasured.** A cloned SwiftPM `.build` embeds absolute paths and may rebuild fully inside a worktree. The spike was skipped, so the Final review's human check measures it.
- **A leak is detected, not prevented.** An agent that edits through an absolute main-tree path is caught at the next land or at wave end, and the run halts. Nothing stops the write itself.
- **`worktree.ts` stays one task on purpose.** Review asked three times to split it by subcommand. It is one script plus one test file, and its subcommands share the snapshot helper and `state.json`, so a split would make three chained tasks edit the same file. The extra review surface is accepted.
- **`sweep` runs a repo-wide `git worktree prune`.** git has no scoped prune. It only drops registrations whose directory is already gone, so it never removes a live worktree anywhere. Review flagged it as touching stale registrations outside the slug root; that is accepted.
- **The leak abort and single-task resume stay one task.** Review asked three times to split them. They share the abort helper and the baseline fingerprint, and the task carries eleven named test cases. The extra review surface is accepted.
- **Retry safety covers lost results, not killed processes.** A `land` or `unland` killed between applying its patch and writing `state.json` is not replayable. The next `--expect` then reports a leak and halts the run: the failure is safe, but a person has to clean up.
- **This plan runs on today's shared-tree autopilot.** Every task runs only its own named test files, so a sibling's half-written test cannot fail it.
