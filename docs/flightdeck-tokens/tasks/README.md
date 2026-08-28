# flightdeck-tokens — Task System

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

`work/01-transcript-source.md`. It is the only task with no dependency, and it owns the
type file every later task imports. The chain after it is strictly linear.

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
| review | 01 | Final Review | todo | > 4 | work/04 |
| work | 01 | Transcript Source | todo | > 4 | — |
| work | 02 | Usage Attribution | todo | > 4 | work/01 |
| work | 03 | SSE Wiring | todo | > 4 | work/02 |
| work | 04 | Dashboard Rendering | todo | > 4 | work/03 |

## Dependency graph

```
work/01
└─→ work/02
    └─→ work/03
        └─→ work/04
            └─→ review/01
```

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| review/01 | work/04 |
<!-- flightplan:generated:end -->

## Known gaps

Recorded decisions, not defects. Do not "fix" these without raising them first.

1. **Attempt is missing from roughly a fifth of agent prompts.** Those agents fall back
   to a task-and-role identity with no attempt, matching the existing identity helper's
   own convention. Harmless while retries are rare — the run this was verified against
   never exceeded attempt 1 — but a heavily-retried plan may mis-pair inside a group.
   The nearest-start-time pairing is the mitigation, not a proof.

2. **Nearest-start-time pairing is a heuristic.** When a fan-out's agents start in the
   same millisecond, which transcript lands on which row is arbitrary (deterministic,
   but arbitrary). Per-task and plan totals stay exact; only the per-row split can be
   wrong.

3. **Codex and OpenCode agents render as unavailable.** They run as subprocesses and
   leave no Claude transcript, so their tokens are not recoverable by this feature. A
   plan executed entirely through a live external engine will show a near-empty token
   column. That is correct, and it is a real coverage cliff.

4. **Discovery is unbounded in file count.** Every workflow directory under the repo's
   project slug is opened once to read its first line. A repo with hundreds of past
   workflow runs pays that scan every time a browser opens the event stream.

5. **The on-disk layout is undocumented.** Every path, filename, and field this feature
   reads was established by inspection on 2026-08-28 against Claude Code 2.1.250. None
   of it is a published contract. When a future version moves any of it, this feature
   degrades to showing nothing rather than showing something wrong — that is the
   intended failure mode and it is worth preserving.

6. **Cache-read and cache-write are collected and deliberately not shown.** Cache-read
   runs roughly 260× output, so rendering it would flatten every other figure. Turning
   it on later is a UI change, not an architecture change.

7. **The input count is hover-only.** It rides a native `title` tooltip, so keyboard and
   touch users cannot reach it. Accepted for this version: no decision depends on the
   input figure, and a keyboard-reachable disclosure is a larger interaction change than
   this feature earns. The headline output figure is plain text and reachable by
   everyone.

8. **Displayed figures are rounded; only the event payload is exact.** `278146` renders
   as `278.1K`. Any check of numeric truth must read the payload, never the screen.
