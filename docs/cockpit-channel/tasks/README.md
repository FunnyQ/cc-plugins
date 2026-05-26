# cockpit-channel — Task System

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

Three roots have no dependencies and can start in parallel: **`backend/01`**
(inbox broker), **`backend/02`** (reply fan-out), and **`launch/01`** (atlas
singleton). The riskiest unknowns live in **`launch/02`** (does
`CLAUDE_CODE_SESSION_ID` reach the channel child? does a notification land in the
transcript?) — do `backend/01` + `backend/02` first so `launch/02` can verify them
end-to-end early. Run `bun /Users/funnyq/.claude/plugins/cache/odin-marketplace/odin/3.2.0/skills/probe-deep/scripts/next-ready.ts docs/cockpit-channel/tasks` to list ready tasks.

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
| backend | 01 | Inbox broker (UI → agent) | done | — |
| backend | 02 | Reply fan-out (agent → UI) | done | — |
| backend | 03 | Session `channel` flag | done | backend/01 |
| launch | 01 | usage-dashboard singleton guard | done | — |
| launch | 02 | Channel MCP server | done | backend/01, backend/02 |
| launch | 03 | Auto-start daemons + reconnect | done | launch/01, launch/02 |
| launch | 04 | Registration + launcher | done | launch/02 |
| ui | 01 | Send box (UI → agent) | done | backend/01, backend/03 |
| ui | 02 | Reply strip (agent → UI) | done | backend/02 |

## Dependency graphs

### `backend/`

```
backend/01  <-  (start)
backend/02  <-  (start)
backend/03  <-  backend/01
```

### `launch/`

```
launch/01  <-  (start)
launch/02  <-  (start)
launch/03  <-  launch/01, launch/02
launch/04  <-  launch/02
```

### `ui/`

```
ui/01  <-  (start)
ui/02  <-  (start)
```

## Cross-bucket dependencies

<!-- Add a third column (Why) by hand if the rationale would help executors. -->

| Task | Depends on |
|---|---|
| ui/02 | backend/02 |
| ui/01 | backend/01, backend/03 |
| launch/02 | backend/01, backend/02 |
<!-- probe-deep:generated:end -->

## Known gaps

<!-- Human-authored. List unresolved decisions or upstream blockers here. -->

1. **Env-var reach (verified in `launch/02`)** — Claude Code `2.1.150` does not
   expose `CLAUDE_CODE_SESSION_ID` to the channel child. The channel now resolves
   the session from ancestor process commands (`--session-id`) before falling back
   to the local transcript finder.
2. **Transcript serialization shape (verified in `launch/02`)** — channel
   injections appear as a `type:"user"` transcript entry whose message string is
   `<channel source="cockpit-channel" source="cockpit">...</channel>`. Agent
   replies appear as an assistant `tool_use` named `mcp__cockpit-channel__reply`.
3. **Reply display vs transcript (open question)** — `ui/02` defaults to a
   dedicated reply SSE strip. The transcript also records the reply tool call,
   but the focused SSE strip remains the primary UI until product feedback says
   transcript filtering is enough.
4. **Research preview volatility** — channels require Claude Code ≥ 2.1.80 and can
   change/break while in preview. Pinned, not worked around.
5. **Daemon death mid-session (verified in `launch/03`)** — killing the cockpit
   daemon while a channel session was active caused the channel to respawn it,
   pick up the rotated token, drain a stashed send, and accept the next live send.
