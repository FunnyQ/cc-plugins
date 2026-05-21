# Token-Atlas LIVE — Task System

Task decomposition for the Token-Atlas dashboard's **LIVE** capability: a "Live now" panel of active Claude sessions (Level 1) and a click-to-open real-time transcript stream (Level 2). Claude-only for v1. The frozen design lives in `../PLAN.md` + `../LIVE_RESEARCH.md`; these tasks are the execution slices.

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
│   ├── shared.md              ← conventions, frontend patterns, commit style, frozen decisions
│   └── data-sources.md        ← LiveSession type, session/transcript read logic, status + security rules
├── panel/                     ← Level 1: "Live now" panel
│   ├── 01-api-live-endpoint.md
│   └── 02-live-now-panel.md
└── stream/                    ← Level 2: real-time transcript stream
    ├── 03-api-stream-sse.md
    └── 04-stream-modal.md
```

## Reading order for executors

1. `_context/shared.md` — required for every task.
2. Topic-specific `_context/*.md` per the task's `Required reading` header.
3. The task file itself.

## Naming convention

`<bucket>/NN-<kebab-slug>.md` — `NN` is two-digit zero-padded.

## Where to start

Start at **`panel/01-api-live-endpoint.md`** — the foundation task with no dependencies. It creates `scripts/live.ts` and the `/api/live` endpoint that both `panel/02` and `stream/03` build on.

Suggested order: `panel/01` → then `panel/02` and `stream/03` can proceed in parallel → `stream/04` last (it needs both). Run `bun <probe-deep>/scripts/next-ready.ts docs/live-feature/tasks` to see which tasks are unblocked as statuses flip to `done`.

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
| panel | 01 | `GET /api/live` active-session endpoint | done | — |
| panel | 02 | "Live now" panel | todo | panel/01 |
| stream | 03 | `GET /api/stream` SSE transcript stream | todo | panel/01 |
| stream | 04 | Streaming transcript modal | todo | stream/03, panel/02 |

## Dependency graphs

### `panel/`

```
panel/01  <-  (start)
panel/02  <-  panel/01
```

### `stream/`

```
stream/03  <-  (start)
stream/04  <-  stream/03
```

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| stream/03 | panel/01 |
| stream/04 | panel/02 |
<!-- probe-deep:generated:end -->

## Known gaps

These surfaced during planning and are intentionally deferred — none blocks v1.

1. **Per-session token/cost** (would affect `panel/02` rows + `stream/04` modal)
   Out of v1 scope. Adds usage parsing + pricing + per-file mtime caching. Revisit after the lean status+stream slice ships.

2. **Codex LIVE** (would add a `codex` provider path across all tasks)
   Deferred to v2. Codex has no on-disk status field equivalent to `~/.claude/sessions/*.json`; options (app-server websocket, SQLite/rollout tail, hooks sidecar) are each substantial. The `provider` / `statusSource` unions in `LiveSession` reserve room so adding it later is additive. Full research in `../LIVE_RESEARCH.md`.

3. **Resume-on-reconnect for the stream** (would affect `stream/03` + `stream/04`)
   v1 re-sends the backlog on every reconnect, which is acceptable. `Last-Event-ID` + per-event byte-offset `id:` is a nice-to-have follow-up.
