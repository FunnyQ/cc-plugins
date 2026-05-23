# cockpit — Task System

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

Start with **`kernel/01-plugin-scaffold.md`** (no dependencies). Then `kernel/02` → `kernel/03`. Once the schema in `kernel/02` is set, `server/01` can begin in parallel.

Run `bun <probe-deep>/scripts/next-ready.ts docs/cockpit/tasks` any time to list tasks whose dependencies are all `done`.

<!-- probe-deep:generated:start -->
## Status conventions

Each task header has a `> **Status**: <status>` line. Executors update it as they go:

- `todo` — not started
- `in-progress` — actively being worked on
- `done` — merged / shipped
- `blocked` — waiting on a decision, upstream task, or external resource

## Task index

| Bucket | NN | Title | Status | Depends on |
|---|---|---|---|---|
| bridge | 01 | Broker endpoints | todo | server/01 |
| bridge | 02 | cockpit wait & send CLIs | todo | bridge/01, kernel/02 |
| bridge | 03 | UI respond buttons | todo | ui/02, bridge/01 |
| kernel | 01 | Plugin scaffold | todo | — |
| kernel | 02 | cockpit CLI (start \| log) | todo | kernel/01 |
| kernel | 03 | /cockpit-start skill | todo | kernel/02 |
| server | 01 | Daemon lifecycle | todo | kernel/01 |
| server | 02 | Registry → projects & sessions API | todo | server/01, kernel/02 |
| server | 03 | Decision-log SSE | todo | server/02 |
| server | 04 | Live-transcript engine | todo | server/01 |
| ui | 01 | SPA shell & 3-column layout | todo | server/02 |
| ui | 02 | Decision-log column | todo | ui/01, server/03 |
| ui | 03 | Live-transcript column | todo | ui/01, server/04 |
| ui | 04 | Info column & DESIGN.md theming | todo | ui/01 |
| ui | 05 | Multi-project nesting | todo | ui/01, server/02 |

## Dependency graphs

### `bridge/`

```
bridge/01  <-  (start)
bridge/02  <-  bridge/01
bridge/03  <-  bridge/01
```

### `kernel/`

```
kernel/01  <-  (start)
kernel/02  <-  kernel/01
kernel/03  <-  kernel/02
```

### `server/`

```
server/01  <-  (start)
server/02  <-  server/01
server/03  <-  server/02
server/04  <-  server/01
```

### `ui/`

```
ui/01  <-  (start)
ui/02  <-  ui/01
ui/03  <-  ui/01
ui/04  <-  ui/01
ui/05  <-  ui/01
```

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| ui/05 | server/02 |
| ui/01 | server/02 |
| ui/02 | server/03 |
| ui/03 | server/04 |
| bridge/02 | kernel/02 |
| bridge/01 | server/01 |
| bridge/03 | ui/02 |
| server/02 | kernel/02 |
| server/01 | kernel/01 |
<!-- probe-deep:generated:end -->

## Known gaps

1. **DESIGN.md token format** (scope: `ui/04-info-column-theming`)
   The Google DESIGN.md token shape that the theming task parses into CSS variables isn't confirmed. Before building, verify the `@google/design.md` CLI `export` output, or the spec saved in Obsidian (`📥 inbox/2026-05-23-design-md-specification.md`). May add a parser sub-task.

2. **Heartbeat staleness window** (scope: `server/02-registry-projects-api`)
   Default is 10 min (matching token-atlas live-session filtering) for the `active → ended` flip. Confirm the value is right while building the registry API.

3. **Unparked sessions can't be woken** (scope: `bridge/01-broker-endpoints`, `bridge/02-cockpit-wait-and-send`)
   The control loop wakes a session only while it has a live `cockpit wait` poll (i.e. parked at a `needs_your_call`). Answering a session whose turn fully ended just appends a `response` record and returns `delivered: false` — no LLM is woken. Closing that gap would need harness-level IPC; out of scope for v1, surfaced honestly in the UI.
