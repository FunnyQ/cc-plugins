# flightdeck — autopilot run monitor

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-07-31

## Overview

A local web UI that renders an autopilot run live: the flightplan task tree on top, the subagent
fleet below. It auto-starts when `/autopilot` launches a flight, reads the run's append-only
flightlog, and never writes anything back.

## Goals

- See which subagents are in flight *right now*, with role, task, attempt, and elapsed time.
- See the task tree's shape and progress at a glance — buckets, dependencies, what is blocked.
- See each task's rubric verdict: weighted score against threshold, per-dimension breakdown, hard-fail.
- Auto-start with `/autopilot` so a run is observable without a second command.

## Non-goals

- **Any write operation.** No re-running a task, no editing `Status`, no sending messages to agents.
  `mark-done.ts` and `score-task.ts` own those files; a second writer would race them.
- **Workflow journal integration.** `journal.jsonl` / `agent-<id>.jsonl` would cover verify and judge
  for free, but no sample exists on disk to verify the path or format against. Deferred.
- **Monitoring several plans at once.** One daemon serves one tree. A later `/autopilot` on a
  different plan supersedes it.
- **Rendering agent transcripts.** cockpit owns that surface. flightdeck shows fleet state only.
- **Authentication or remote access.** Binds `127.0.0.1`, same as the sibling dashboards.

## Context

`autopilot` executes a `docs/<slug>/tasks/` tree through a per-task dev → verify → judge → score
loop, then a closing multi-lens final review. Today its entire live state exists only in the Workflow
orchestrator's memory. When the run ends, all that survives is `RUNLOG.md`. There is no way to watch
a flight in progress: which wave is running, how many agents are in flight, which task is on its
third attempt.

Every input needed already exists and is machine-readable:

| Data | Source |
|---|---|
| Task tree, status, deps, rubric | `loadAllTasks()` in `packages/dispatch/skills/flightplan/scripts/next-ready.ts` → `ParsedTask` |
| Score verdicts | `ScoreEntry` in `.flightlog/run.jsonl` — `weighted`, `threshold`, `passed`, `hardFailed`, `attempt`, `breakdown[]` |
| Agent narrative | `NoteEntry` in the same file — `role`, `agentLabel`, `message` |
| Agent identity | `agentLabel`, following the orchestrator's label taxonomy |

One gap: the flightlog is **finish-only**. An agent appends its entry after it completes, so an
in-flight agent is invisible and the screen would sit on the last completed state. Every agent in the
loop already shells out (verify runs the task's Verification commands, judge runs `score-task.ts`,
scout runs `next-ready.ts`), so adding one start-log line per prompt costs a line and changes no
agent's shape.

## Requirements

### MVP

1. **Phase-tagged flightlog** — `NoteEntry` gains an optional `phase: "start" | "end"`.
   - Acceptance: all four existing `docs/*/.flightlog/run.jsonl` still parse; `renderRunlog` output
     for them is byte-identical; `flightlog.ts log --phase start` round-trips.
2. **Derived task state** — pure functions computing `ready` / `blocked` / `in-progress` / `done`
   plus `blockedBy[]`, which the task files themselves do not record.
   - Acceptance: unit tests cover each state and a multi-dependency blocked task.
3. **Agent label parsing** — every label the orchestrator emits parses into `{role, ref, attempt, lens}`.
   - Acceptance: unknown labels degrade to `role: "unknown"` rather than throwing.
4. **Static serving** — a module that maps a request path to a file inside the committed SPA directory,
   with the traversal check isolated as a pure function.
   - Acceptance: plain, encoded, absolute, and prefix-sibling escapes are all rejected.
5. **Server process** — a Bun server bound to `127.0.0.1:5757` that serves the SPA and records itself.
   - Acceptance: serves the page, writes its record only after binding, removes it on either stop signal.
6. **Launcher** — decides start, reuse, or supersede; spawns the server detached and confirms it answers.
   - Acceptance: launching returns control immediately and leaves a listener; launching twice binds once.
7. **`/api/tree`** — the full task tree with derived state, read fresh on every request.
   - Acceptance: `curl -s localhost:5757/api/tree | jq` returns every task in
     `docs/waypoints-skill/tasks` with correct `state` and `blockedBy`.
8. **`/api/events` SSE** — aggregated fleet snapshots as the run's flightlog grows.
   - Acceptance: append a line by hand; a connected client receives an updated snapshot within 2s.
9. **Hangar design system** — `PRODUCT.md` plus the token layer.
   - Acceptance: `PRODUCT.md` records the palette, type scale, and anti-goals; every colour in
     `style.css` comes from a named token.
10. **Task lanes** — bucket columns of task cards with status colour, progress ring, blocked-by badges.
   - Acceptance: rendering `docs/waypoints-skill/tasks` shows 6 tasks in 3 buckets with correct badges.
11. **Agent fleet** — live rows with role, task, attempt, elapsed, and score meter plus rubric bars.
   - Acceptance: replaying `docs/chronicle/.flightlog/run.jsonl` renders its score entries with
     correct weighted value, threshold marker, and hard-fail state.
12. **Dependency graph** — hand-laid SVG, layered by primary parent, tinted by live status.
   - Acceptance: no `vendor/` addition; nodes recolour on an SSE event without relayout.
13. **Start events in the orchestrator** — every agent prompt logs `--phase start` first.
    - Acceptance: a real fixture flight shows a start entry for dev, verify, judge, and scout, all in
      one `.flightlog/` directory.
14. **Auto-start from the skill** — `/autopilot` launches flightdeck after the user confirms the flight.
    - Acceptance: running `/autopilot` on the fixture tree opens the browser once and the page shows
      that tree.

### Later

- **Workflow journal layer** — covers verify/judge without touching any prompt, once the path and
  format are confirmed from a real run.
- **Plan picker** — browse past runs across all `docs/*/.flightlog/`.
- **Post-mortem export** — a self-contained HTML snapshot of a finished run.

## Tech decisions

- **Stack**: Bun + TypeScript, no transpile. Frontend is petite-vue with a committed
  `dashboard/dist/`, no build step, no npm dependencies. `type` over `interface`.
- **Storage**: none. Every byte is read from the plan tree and its `.flightlog/`.
- **Port**: `5757`. `5938` is usage-dashboard, `5858` is cockpit.
- **Placement**: all new work lives under `packages/dispatch/skills/autopilot/` — server and pure code in
  `scripts/`, the committed SPA in the sibling `dashboard/dist/`, and the design direction in `PRODUCT.md`
  at the skill root. This reverses the standing rule that autopilot ships no scripts; `autopilot/SKILL.md`
  states that invariant and must be updated.
- **Cross-plugin rule**: dispatch must not depend on monitor. cockpit's `sse-tailer.ts`,
  `daemon-lifecycle.ts`, and `shared/scripts/static-server.ts` are **patterns to copy**, never imports.
- **Cross-skill imports**: flightdeck imports `loadAllTasks` from
  `../../flightplan/scripts/next-ready` and the entry types from
  `../../flightplan/scripts/lib/flightlog`. Both skills ship in one plugin at one version, so the
  relative path holds in the marketplace cache. This is the repo's first cross-skill import.
- **Conventions**: see `tasks/_context/shared.md`.

## Architecture

```
/autopilot (main agent, after the Step 2 confirm)
   │
   └─ bun autopilot/scripts/flightdeck.ts --plan <abs docs/slug>
         │
         ├─ singleton check → start | reuse | supersede   (PID file)
         ├─ Bun.serve 127.0.0.1:5757
         │     ├─ GET /            → dashboard/dist/       (static)
         │     ├─ GET /api/tree    → loadAllTasks + deriveTaskState
         │     └─ GET /api/events  → SSE tail of run.jsonl
         └─ open browser once

Workflow orchestrator (unchanged control flow)
   └─ each agent prompt, step 1:
        bun flightplan/scripts/flightlog.ts log ${CFG.logFile} \
            --task <ref> --role <role> --phase start --agent "<label>"
                          │
                          ▼
        docs/<slug>/.flightlog/run.jsonl   ← the single live channel
```

The UI is a strict read layer. It is out-of-band: if the daemon dies mid-flight, the run is unaffected.

## Bucketing

- **Strategy**: layer, with the data contract pulled out in front.
- **Why**: freezing the entry shape and the pure state functions first lets `server` and `ui` proceed
  in parallel, and keeps the risky `wiring` edits last, after there is something to verify against.

### Buckets

- **`contract/`** — the data model: the flightlog phase field and the pure derivation functions. Ends
  when both are unit-tested.
- **`server/`** — static serving, the resident server process, its launcher, `/api/tree`, and the event
  stream, each layered on the one before. Ends when both endpoints answer correctly against an existing
  plan tree.
- **`ui/`** — the Hangar design system and the three views. Ends when the page renders a real tree and
  a real flightlog.
- **`wiring/`** — the autopilot edits, the fixture flight, and the closing review. Ends when a real
  flight is observable end to end.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| contract | 01 | flightlog phase events | todo | > 4.0 | — |
| contract | 02 | fleet and task state derivation | todo | > 4.0 | contract/01 |
| server | 01 | static file serving | todo | > 4.0 | — |
| server | 02 | the server process | todo | > 4.0 | server/01, ui/01 |
| server | 03 | the launcher | todo | > 4.0 | server/02 |
| server | 04 | tree endpoint | todo | > 4.0 | server/03, contract/02 |
| server | 05 | fleet event stream | todo | > 4.0 | server/04 |
| ui | 01 | Hangar design system + shell | todo | > 4.0 | — |
| ui | 02 | task lanes | todo | > 4.0 | ui/01, server/04 |
| ui | 03 | agent fleet + score meters | todo | > 4.0 | ui/01, server/05 |
| ui | 04 | SVG dependency graph | todo | > 4.0 | ui/02, ui/03 |
| wiring | 01 | orchestrator start events | todo | > 4.0 | contract/01 |
| wiring | 02 | SKILL.md auto-start | todo | > 4.0 | server/03 |
| wiring | 03 | fixture flight verification | todo | > 4.0 | wiring/01, wiring/02, ui/03, ui/04 |
| wiring | 04 | final review 🏁 | todo | > 4.0 | wiring/03, contract/02, server/05, ui/04 |

(Mirrors the table in `tasks/README.md` — keep them in sync. The last row is the **final review** task,
marked `> **Final review**: true` in its file.)

## Cross-bucket dependencies

```
contract/01 ─┬─ contract/02 ──────────────────┐
             │                                ├─ server/04 ─┬─ server/05 ── ui/03 ─┬┐
server/01 ─┬─ server/02 ── server/03 ─────────┘             │                     ││
ui/01 ─────┘                    │                           └─ ui/02 ── ui/04 ────┘│
                                └─ wiring/02 ─────────────────────────── wiring/03 ── wiring/04
                                                                             │
contract/01 ── wiring/01 ────────────────────────────────────────────────────┘

ui/01 ──────────────────────────── ui/02, ui/03
```

Three tasks have no dependencies at all — `contract/01`, `server/01`, and `ui/01` — so wave 1 runs the
data model, the static-serving module, and the design system in parallel. The server bucket then builds
up in a line, and the ui bucket follows each endpoint as it lands.

Two edges exist for **write-set isolation rather than logic**, and both are easy to mistake for
over-constraint. `server/02` depends on `ui/01` because the server needs a real page in `dashboard/dist/`
to verify its static route, and that directory belongs to the design task. `ui/04` depends on `ui/03`
because both edit `app.js` and `style.css`; running them in one wave would have them clobber each other.

## Failure modes & rollback

- **A bad `orchestrator.md` edit breaks every future flight.** It is a 491-line file driving all
  autopilot runs. The fixture flight is the gate; rollback is `git revert` of that task's commit.
- **The nested-flightlog trap.** `orchestrator.md` documents it: a relative `logFile` resolves against
  whichever agent's cwd is current and splits the trail. Every start-log line must use the same
  absolute `${CFG.logFile}` the existing lines use.
- **Port 5757 already bound.** The singleton decision distinguishes a same-install daemon (reuse) from
  a stale one (supersede); `--port` overrides for a dev instance.
- **A half-written plan tree.** If any step of the write sequence fails, run `trash docs/flightdeck/`
  and restart from `scaffold.ts`.
- **A malformed flightlog line.** `parseLog` already drops bad lines rather than aborting. The SSE
  tail must inherit that tolerance, not throw.

## Open questions

1. **Workflow journal path and format** — no sample on disk to inspect. Confirm during the fixture
   flight, then decide whether the deferred layer is worth building.
2. **dispatch version bump and release** — out of scope here. `/chronicle:release` owns it once this
   tree lands.

## Known gaps

- The verify and judge stages are visible only as start/end markers, not as streamed reasoning. Their
  structured verdicts reach the orchestrator, not the flightlog.
- Elapsed time is derived from start/end entry timestamps, so an agent that dies without writing an
  end entry stays "in flight" until the run finishes. No staleness ceiling in v1.
- The event-stream task carries both the tail engine and the SSE handler. Review suggested splitting it;
  it was left whole because the seam already exists as two separately tested modules, and an executor
  writing the handler needs the cursor semantics in front of them.
- Two dependency edges exist purely to serialise overlapping write sets rather than to order logic. They
  cost some parallelism in exchange for not having two agents edit one file in the same wave.

## References

- `packages/dispatch/skills/autopilot/references/orchestrator.md` — agent label taxonomy, prompt bodies
- `packages/dispatch/skills/flightplan/scripts/lib/flightlog.ts` — entry types
- `packages/monitor/skills/cockpit/scripts/sse-tailer.ts` — the tail-resilience pattern to copy
- `packages/monitor/skills/cockpit/scripts/daemon-lifecycle.ts` — the singleton decision to copy
