# adr-multi-promotion — Task System

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

`contract/01-gate-protocols.md`. It converts both human gates in the skill file, and it is
the only task the second `contract` task waits on.

Wave 1 runs four tasks in parallel, each on a different file: `contract/01`, `agents/01`,
`agents/02`, `agents/03`. Wave 2 runs `contract/02` plus the three `codex` mirrors. Wave 3
is the closing review.

Every task edits instruction text only. No task changes a script, and no task commits.

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
| agents | 01 | Codifier drafts N records | todo | > 4 | — |
| agents | 02 | Lorekeeper batch phase contracts | todo | > 4 | — |
| agents | 03 | Barrowkeeper batch write | todo | > 4 | — |
| codex | 01 | Codifier TOML mirror | todo | > 4 | agents/01 |
| codex | 02 | Lorekeeper TOML mirror | todo | > 4 | agents/02 |
| codex | 03 | Barrowkeeper TOML mirror | todo | > 4 | agents/03 |
| contract | 01 | Gate protocols for a batch of drafts | todo | > 4 | — |
| contract | 02 | Batch mechanics and failed-batch recovery | todo | > 4 | contract/01 |
| review | 01 | Final review 🏁 | todo | > 4 | contract/02, codex/01, codex/02, codex/03 |

## Dependency graph

```
agents/01
└─→ codex/01
agents/02
└─→ codex/02
agents/03
└─→ codex/03
contract/01
└─→ contract/02
    └─→ review/01 *
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| codex/03 | agents/03 |
| codex/01 | agents/01 |
| codex/02 | agents/02 |
| review/01 | contract/02, codex/01, codex/02, codex/03 |
<!-- flightplan:generated:end -->

## Known gaps

1. **The 12-group batch cap is a judgment call** (scope: `contract/02`, `agents/01`,
   `codex/01`, flagged by `review/01`)
   Q ran 26 groups in one sitting and reports the limit was review fatigue, not failure.
   Nothing measured a ceiling. The closing review is told to flag the cap if the converted
   Codifier instructions read as fragile at that size. Only Q can move the number.

2. **Nothing cross-validates a Codex TOML mirror against its Markdown source** (scope: the
   three `codex` tasks)
   No test, no linter, and no script compares the two. Each mirror task and the closing
   review check the pair by hand. A future drift will be silent again.

3. **The gate-1 fallback page still round-trips plaintext JSON** (scope: `contract/01`)
   The HTML ledger gains a `group` column and copies it into the JSON, but the round-trip
   is still copy-and-paste. Drag-to-group, group colouring, and client-side validation of
   the consistency check are out of scope. The plaintext round-trip is the contract.
