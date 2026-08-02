# cockpit-svg-diagram — Task System

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

Start with `cli/01-diagram-format-contract.md`. It is the foundation task that fixes the format discriminator every other task reads.

`ui/02-style-scoping.md` has no dependencies either, so it can run in parallel from the outset.

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
| cli | 01 | Diagram format contract and @path input | todo | >= 4 | — |
| cli | 02 | SVG lint at write time | todo | >= 4 | cli/01 |
| cli | 03 | Cross-format fix hint in the Mermaid lint | todo | >= 4 | cli/01 |
| docs | 01 | Authoring reference for the SVG escape hatch | todo | >= 4 | cli/02, cli/03, ui/03 |
| docs | 02 | Final review | todo | >= 4 | cli/01, cli/02, cli/03, ui/01, ui/02, ui/03, docs/01 |
| ui | 01 | SVG render path, sanitize policy and theme tokens | todo | >= 4 | cli/01 |
| ui | 02 | Scope author SVG styles to their figure | todo | >= 4 | — |
| ui | 03 | Card integration, failure fallback and lightbox | todo | >= 4 | ui/01, ui/02 |

## Dependency graph

```
cli/01
├─→ cli/02
│   └─→ docs/01 *
├─→ cli/03
├─→ docs/02 *
└─→ ui/01
    └─→ ui/03 *
ui/02
```

`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| ui/01 | cli/01 |
| docs/01 | cli/02, cli/03, ui/03 |
| docs/02 | cli/01, cli/02, cli/03, ui/01, ui/02, ui/03 |
<!-- flightplan:generated:end -->

## Known gaps

- **No cap on diagram size**, by decision.
- **The Mermaid no-regression evidence is a sample, not a proof.** The goal is that every existing Mermaid entry renders byte-identically, but the sanitize-policy comparison covers a deliberate spread (flowchart with semantic classes, `stateDiagram-v2`, `sequenceDiagram` with a note, `classDiagram`, a punctuated edge label) rather than all 35 types in `DIAGRAM_TYPES`. The tightened policy only narrows URI handling and mermaid's strict output emits no external references, so the residual risk is confined to a diagram type that emits a URI-bearing attribute. Accepted rather than exhaustively tested.
- **Author CSS containment rests on an enumerated grammar.** The scoping pass drops every construct outside a listed set instead of parsing CSS generally, so a browser-valid rule the grammar does not model is silently dropped and an unusual authoring style loses its styling. That is the intended trade: over-dropping costs one diagram, under-dropping costs the page.

Two questions are open but non-blocking, each resolved inside the task that hits it: whether happy-dom's CSSOM is strong enough to unit-test the scoping pass (`ui/02`), and whether `transcript.js`'s global DOMPurify `afterSanitizeAttributes` hook affects `<a>` inside an SVG (`ui/01`).
