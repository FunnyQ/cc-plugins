# `tasks/README.md` Template

`tasks/README.md` is the entry point for any executor (human or sub-agent). It explains how to read the tree, the status conventions, the dependency graph, and known gaps.

**Most of this file is generated.** `scripts/build-readme.ts` parses every task header and regenerates the task index (Bucket / NN / Title / Status / **Pass 線** / Depends on — the Pass 線 column shows each task's Eval-rubric pass threshold, e.g. `> 4`, or `—` if the rubric is unparseable), per-bucket dep graphs, and cross-bucket dep table between the markers:

```
<!-- flightplan:generated:start -->
... generated content ...
<!-- flightplan:generated:end -->
```

The prologue (purpose, directory layout, reading order, naming) and epilogue (`## Known gaps`) are human-authored and preserved across regeneration. Rerun `build-readme.ts` whenever a task's header changes (status, deps, title).

## Template

```markdown
# <Topic> — Task System

<One-line topic description.>

## Purpose

Each task file is a **self-contained, independently pickable unit**. An executor needs only:

1. The `_context/` files listed in the task's `Required reading` header
2. The task file itself

They should not need to open `PLAN.md` or any other task file. `PLAN.md` remains the master spec / source of truth; `_context/` is its surgical extract; task files describe "what to do" without re-explaining "why".

## Directory layout

```
tasks/
├── README.md                  ← this file
├── _context/                  ← shared context (every task references these)
│   ├── shared.md              ← decisions, conventions, commit style
│   └── <other>.md             ← topic-specific shared context
├── <bucket>/                  ← bucket description
│   ├── 01-<slug>.md
│   └── ...
└── <bucket>/
    └── ...
```

## Reading order for executors

1. `_context/shared.md` — decisions, conventions, commit style. Required for every task.
2. Topic-specific context per task's `Required reading` header.
3. The task file itself.

## Status conventions

Each task header has a `> **Status**: <status>` line. The executor updates it as they go:

- `todo` — not started
- `in-progress` — actively being worked on
- `done` — merged / shipped into the target branch
- `blocked` — waiting on a decision, upstream task, or external resource

## Naming convention

`<bucket>/NN-<kebab-slug>.md` — `NN` is two-digit zero-padded (`01`, `02`, … `19`, `20`).

## Suggested execution order

<Describe the natural sequence. For multi-bucket plans, identify which buckets can run in parallel and which must wait.>

```
<bucket-1> (all)  ───────┐
                          ↓
   (after <bucket-1> task NN, <bucket-2> can start in parallel)
                          ↓
<bucket-2> (all)  ───────┤
                          ↓
                       <bucket-3>
                          ↓
                       Ship
```

## Dependency graphs

### `<bucket>/`

```
01-<slug> ─┬─→ 02-<slug> ─→ 04-<slug>
            └─→ 03-<slug>
```

### `<bucket>/`

```
01-<slug> ─→ 02-<slug> ─┬─→ 03-<slug>
                        └─→ 04-<slug>
```

## Cross-bucket dependencies

For multi-bucket plans, document which tasks across buckets are linked:

| Task | Needs | Why |
|---|---|---|
| api/01 | backend/01, ui/02 | <reason> |
| api/02 | backend/01 | <reason> |

## Known gaps

Decisions or design questions that surfaced during planning but weren't resolved. Each entry is a blocker waiting to be addressed; resolving it may add or change task files.

1. **<Gap title>** (<scope: which task affected>)
   <Context, what needs to happen, who can decide.>

2. **<Gap title>** (<scope: which task affected>)
   <Context, what needs to happen, who can decide.>

## Where to start

<First task to execute. Usually the foundation task in the earliest bucket.>

```

## Tailoring rules

- **Single-bucket plans**: drop the dependency-graph-per-bucket section and just show one graph. Task files still live under `tasks/<bucket-name>/`, never flat under `tasks/`.
- **No cross-bucket deps**: drop that table.
- **No open gaps**: drop "Known gaps" — but verify there really are none rather than hiding them.
- **Writing topic**: replace "Suggested execution order" with "Suggested drafting order" and dependency graphs become section-ordering graphs.

## Why this file matters

A sub-agent in a future session may be the only executor. The README is what orients them. Treat it as a contract:

- Naming conventions documented here are the conventions they will follow.
- Status values documented here are the values they will use.
- The dependency graph here is what tells them what's safe to start.
- Known gaps prevent them from inferring decisions that haven't been made.

If the README is incomplete, the executor will guess. Guessing is the failure mode flightplan exists to prevent.
