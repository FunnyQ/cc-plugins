# teacher-lesson-log — Task System

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

Start with `work/01-lessons-db-and-record-cli.md`. Once it lands, `work/02` and `work/03` touch disjoint files and can run in parallel.

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
| review | 01 | final review 🏁 | todo | > 4 | work/02, work/03 |
| work | 01 | lessons-db-and-record-cli | todo | > 4 | — |
| work | 02 | record-attempts-from-the-mod | todo | > 4 | work/01 |
| work | 03 | label-and-stats-cli | todo | > 4 | work/01 |

## Dependency graph

```
work/01
├─→ work/02
│   └─→ review/01 *
└─→ work/03
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| review/01 | work/02, work/03 |
<!-- flightplan:generated:end -->

## Known gaps

- **No opt-in**: other users' scrubbed prompts land on disk while the teacher is on. Disclosed in the config template and CLAUDE.md only (Q's decision).
- **Typecheck**: runes' `tsconfig.json` loads only mod types, so `bun:sqlite` and `Bun` in the new CLI files do not typecheck there, the same as `explain/geometry-cli.ts`.
- **Live write path**: the test kit has no process, so the real spawn is verified only by the `(human)` session check.
- **Repeat prompts**: the teacher's 50-entry cache skips an already-asked prompt, so a repeat in one session leaves no second row.
- **haiku sees the raw prompt**: unchanged; only what lands on disk is scrubbed.
- **Scrub is patterns**: `scrub()` masks known secret shapes, not every secret.
- **`project` after `/cd`**: `project` is the basename of the cwd at `session.start`, so after `/cd` or a worktree move rows keep the old project name. Fix by capturing the cwd per submit, like the session id, if it matters for stats.
- **Review-judged checks**: unchanged pre-existing assertions, unreformatted untouched lines, and the import lists of the new files are checked by reading the diff, not by a command.
