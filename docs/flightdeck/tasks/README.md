# flightdeck — Task System

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

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| contract | 01 | flightlog phase events | todo | > 4 | — |
| contract | 02 | fleet and task state derivation | todo | > 4 | contract/01 |
| server | 01 | static file serving | todo | > 4 | — |
| server | 02 | the server process | todo | > 4 | server/01, ui/01 |
| server | 03 | the launcher | todo | > 4 | server/02 |
| server | 04 | the tree endpoint | todo | > 4 | server/03, contract/02 |
| server | 05 | the fleet event stream | todo | > 4 | server/04 |
| ui | 01 | Hangar design system and page shell | todo | > 4 | — |
| ui | 02 | task lanes | todo | > 4 | ui/01, server/04 |
| ui | 03 | agent fleet and score meters | todo | > 4 | ui/01, server/05 |
| ui | 04 | SVG dependency graph | todo | > 4 | ui/02, ui/03 |
| wiring | 01 | orchestrator start events | todo | > 4 | contract/01 |
| wiring | 02 | skill auto-start and the retired invariant | todo | > 4 | server/03 |
| wiring | 03 | fixture flight verification | todo | > 4 | wiring/01, wiring/02, ui/03, ui/04 |
| wiring | 04 | final review | todo | > 4 | wiring/03, contract/02, server/05, ui/04 |

## Dependency graph

```
contract/01
├─→ contract/02
└─→ wiring/01
    └─→ wiring/03 *
        └─→ wiring/04 *
server/01
└─→ server/02 *
    └─→ server/03
        ├─→ server/04 *
        │   └─→ server/05
        └─→ wiring/02
ui/01
├─→ ui/02 *
│   └─→ ui/04 *
└─→ ui/03 *
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| ui/02 | server/04 |
| ui/03 | server/05 |
| server/04 | contract/02 |
| server/02 | ui/01 |
| wiring/01 | contract/01 |
| wiring/03 | ui/03, ui/04 |
| wiring/04 | contract/02, server/05, ui/04 |
| wiring/02 | server/03 |
<!-- flightplan:generated:end -->

## Known gaps

- **The Workflow runtime's own journal is not consumed.** `journal.jsonl` and `agent-<id>.jsonl` would
  cover the verify and judge stages without touching any prompt, but no sample was found on disk, so the
  path and format are unverified. The fixture flight records anything it observes about them; building on
  that layer is deferred.
- **No staleness ceiling on in-flight rows.** An agent that dies without writing its end marker reads as
  in flight until the run ends. Accepted for this version; a timeout would need a wall clock in code that
  is deliberately pure.
- **The event-stream task is large.** It carries both the tail engine and the SSE handler. The seam is
  real and already reflected in two modules with their own tests, so it was left as one task rather than
  split — an executor building the handler needs the cursor semantics in front of them. Revisit if it
  proves too big in practice.
- **The fixer may not appear at all.** The final-review fixer runs only when the closing review finds
  something to fix, so a clean run legitimately produces no `fix` row. Its instrumentation is therefore
  verified opportunistically rather than required.
- **Verify and judge appear only as markers.** Their structured verdicts go to the orchestrator, not the
  flightlog, so the fleet shows that they ran and for how long, not what they reasoned.
