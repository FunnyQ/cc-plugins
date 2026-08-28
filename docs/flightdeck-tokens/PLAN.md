# Flightdeck Token Usage

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-08-28

## Overview

Show per-agent, per-task, and whole-plan token usage in flightdeck by reading the
per-agent transcripts Claude Code already writes for every Workflow-spawned agent.

**"Per-role" is delivered by the per-agent figure, not by a role aggregate.** A fleet
row *is* one agent, identified by role, task ref, and attempt, so a Tokens column on
that row answers "what did the judge burn on this task" directly. A panel that sums
every judge across the whole plan is a different feature and is out of scope — see
Non-goals.
Nothing in the autopilot pipeline records tokens today; the data exists on disk and
only needs to be found, tailed, attributed, and rendered.

## Goals

- A **Tokens** column on every fleet row, live, updating with the run.
- A per-task token total on every lanes card.
- A whole-plan total in the header, beside Elapsed and the counts.
- Zero changes to the autopilot orchestrator — past runs light up retroactively.

## Non-goals

- **No dollar cost.** Pricing lives in `monitor`, and the task contract forbids
  cross-plugin imports. Duplicating a price table is a separate decision.
- **No cache-read / cache-write in the UI.** The reader captures all four counters
  (they arrive in one `usage` object — filtering them out would be *more* code), but
  only `output` and `input` are rendered.
- **No codex / opencode token capture.** Those run as subprocesses and their usage
  lands in `~/.codex/`, not in any Claude transcript. Those rows render `N/A`, never `0`.
- **No new dashboard view.** No role-rollup panel, no charts, no cross-plan history.
- **No budget enforcement.** The orchestrator's `budgetFloor` knob is untouched.
- **No orchestrator edit.** `references/orchestrator.md` is a fenced JS block consumed
  verbatim by the Workflow runtime; this feature stays out of it.
- **No persisted cursor state.** Cursors live in memory for the life of one SSE stream.

## Context

Verified on disk 2026-08-28, Claude Code 2.1.250, against
`docs/autopilot-graph-v2/.flightlog` (48 agents). The full findings — paths, entry
shapes, prompt patterns, measured numbers — are frozen in
`tasks/_context/data-model.md`, which is the source every task reads. The three that
shaped the architecture:

- Workflow agents write one transcript each under
  `<sessionId>/subagents/workflows/wf_<runId>/`, **not** under `<sessionId>/subagents/`.
  Looking only in the latter finds zero and reads as "Workflow agents leave no trace".
- **`agentLabel` is unusable as a join key.** Agents choose their own label; the real
  trail holds `CODEX-reviewer`, `Haiku Scout`, `Independent Verifier`,
  `altitude-reviewer` alongside structured `dev-codex:lint/01#1`. The join runs on
  `(task, role, attempt)` parsed from the agent's opening prompt instead.
- One `(task, role, attempt)` can host several agents: `integration/01|review` had 5
  (the final-review lens fan-out), `scout|scout` had 7 (one per wave). The join is
  N-to-M, resolved by nearest start time.

## Requirements

### MVP

1. **Transcript discovery** — from a plan dir, reach every agent transcript belonging to
   that plan, across every workflow directory the plan ever produced.
   - Acceptance: for a plan dir that has run, the reader returns one entry per agent
     transcript that names that plan, drawn from every matching workflow directory;
     it returns an empty list for a plan that never ran, for a missing projects
     directory, and for a projects directory that does not exist *yet*.
   - Directories are an implementation detail, not an output. Nothing in this feature
     exposes a list of directories — the only contract is the per-agent list.
2. **Incremental tail** — read only bytes appended since the last pass.
   - Acceptance: a second pass over an unchanged file reads 0 bytes and returns the
     same totals; a file that shrank is re-read from 0.
3. **Attribution** — map each agent's usage to `(task, role, attempt)`, then to a fleet row.
   - Acceptance: within an identity group, agents pair to rows by nearest start time,
     one-to-one; leftovers still count toward task and plan totals. Conservation holds:
     `sum(byTask) + unattributed === totals`.
4. **Live delivery** — usage rides the existing `fleet` SSE frame.
   - Acceptance: the frame carries a usage rollup; a running autopilot shows numbers
     climbing without a page reload.
5. **Rendering** — fleet column, lanes card total, header total.
   - Acceptance: output tokens are the headline everywhere; the input count is carried
     in the cell's `title` tooltip; a row with no matched transcript reads `N/A`.
   - **Displayed figures are abbreviated and rounded** (`278146` renders `278.1K`).
     That is the intended presentation, so no check of numeric truth may read the
     screen — see the exactness rule below.

### Later

- Dollar cost — needs a pricing decision (duplicate `monitor`'s table, or lift it to a
  shared location the import ban permits).
- Cache-read / cache-write display — the reader already collects them; re-enabling is
  a UI change, not an architecture change.
- Codex / opencode usage — requires a `~/.codex/` reader and an opencode equivalent.

## Tech decisions

- **Stack**: Bun + TypeScript, no transpile step. `type` over `interface`.
  Frontend is petite-vue against the committed `dashboard/dist/` — no build step.
- **No new dependencies.** Runtime deps stay at zero.
- **No cross-plugin imports.** `dispatch` must not import from `monitor`.
- **Reuse over new code.** Three existing pieces carry this feature:
  - `tail.ts` — `nextCursor()` and `splitCompleteLines()`, already the tested
    incremental-tail primitives. `readRange()` currently lives as a closure inside
    `events-api.ts`; **lift it into `tail.ts` and export it** rather than writing a
    second copy.
  - `fleet.ts` — `fleetIdentity(task, role, attempt)` is already the grouping key
    this join needs.
  - `events-api.ts` — the poll / watch / debounce loop. The transcript scan hangs off
    that cadence; it does not get its own loop.
- **Cursor state is in-memory**, held by the SSE stream closure like the flightlog
  cursor already is. `daemon-record.ts` is the precedent that reading outside the repo
  is acceptable in this package.
- **Cross-run scope: cumulative.** `run.jsonl` is append-only across re-runs, so usage
  sums every matching `wf_*` dir. "How much did this plan burn" is the definition —
  the two panels never disagree about scope.
- **A fixture generator, and one flag to point at it.** The review loop kept surfacing
  the same defect in a new file: every manual gate said "open a plan that has already
  run", and Claude Code deletes transcripts on a retention schedule. Such a gate passes
  today, silently reports zero-versus-zero in a month, and cannot run on another
  machine at all. So the tree ships `scripts/usage-fixture.ts`, which builds a complete
  scenario in a temp dir and declares the numbers it built, and the server takes
  `--projects-root <dir>` to read it. Two small pieces of surface bought against a
  named failure: three of this plan's own mandatory gates were otherwise unsatisfiable.
  The flag defaults to the real location and changes nothing in normal use.

## Architecture

```
docs/<slug>/                       ~/.claude/projects/<repo-slug>/
  .flightlog/run.jsonl               <sessionId>/subagents/workflows/wf_*/
        |                                     agent-*.jsonl
        |                                          |
   parseLines()                        usage-source.ts  (tail.ts: nextCursor,
        |                              discover + tail   splitCompleteLines, readRange)
   aggregateFleet()                             |
   FleetRow[]  ------------\             AgentUsage[]
                            \                /
                    usage-attribute.ts  (pure)
                    nearest-start-time 1:1 within fleetIdentity() groups
                             |
                    rows[].usage  +  { byTask, unattributed, totals, agentCount }
                             |
                    events-api.ts -> the fleet SSE frame
                             |
              fleet.js column | lanes.js card | index.html header
```

## Bucketing

- **Strategy**: single bucket.
- **Why**: four tasks on one vertical slice. Layered buckets would add path noise
  without unlocking any parallelism the dependency edges don't already express.

### Buckets

- **`work/`** — the whole feature, from disk reader to rendered pixel.
- **`review/`** — the closing final-review task, nothing else.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| work | 01 | transcript-source | todo | > 4.0 | — |
| work | 02 | usage-attribution | todo | > 4.0 | work/01 |
| work | 03 | sse-wiring | todo | > 4.0 | work/02 |
| work | 04 | dashboard-rendering | todo | > 4.0 | work/03 |
| review | 01 | final review 🏁 | todo | > 4.0 | work/04 |

**The chain is linear on purpose.** An earlier draft ran the reader and the attribution
layer in parallel, since the type contract is frozen up front. That is a trap: both
need `usage-types.ts`, so in a shared working tree they race to create the same file
and whichever loses fails its own tests. One owner per file beats a parallelism this
tree is too small to benefit from. `review/01` reaches every task transitively.

## Eval rubric

Shared bar in `tasks/_context/rubric.md`: pass `> 4.0` on a 0–5 scale,
`Correctness < 4` vetoes, weights Correctness ×3 / Test coverage ×2 /
Interface & readability ×1 / Assumptions & docs ×1.

The final-review task scores integration axes instead, plus a low-weight **Leanness**
axis — this feature's main over-engineering risk is a caching or persistence layer
nobody asked for.

## Open questions

None blocking. Both deferred items (cost, cache display) are recorded under
Requirements → Later with the reason.

## Known gaps

1. **Attempt is absent from roughly a fifth of prompts.** Those fall back to
   `(task, role)` with `attempt` undefined, matching `fleetIdentity`'s own `?? "-"`
   convention. Harmless while retries are rare (the reference run peaked at attempt 1),
   but a heavily-retried plan may mis-pair within a group. Nearest-start-time pairing
   is the mitigation, not a proof.
2. **Nearest-start-time pairing is a heuristic.** When a fan-out's agents start in the
   same millisecond, the pairing between rows and transcripts is arbitrary. Task and
   plan totals stay exact; only the per-row split can be wrong.
3. **Codex / opencode rows render `N/A`.** A plan run entirely through a live external
   engine shows a near-empty fleet column. Correct, not a bug, but a real coverage cliff.
4. **Discovery is unbounded in file count.** Every `wf_*` dir under the repo's project
   slug is opened once to read its first line. A repo with hundreds of past workflow
   runs pays that scan on every stream start.
5. **The input count is hover-only.** It rides a native `title` tooltip, so keyboard and
   touch users cannot reach it. Accepted: no decision depends on the input figure, and a
   keyboard-reachable disclosure is a larger interaction change than this feature earns.
   Output — the headline — is plain text and reachable by everyone.

## References

- `packages/dispatch/skills/autopilot/scripts/{flightdeck,events-api,fleet,tail,tree-api}.ts`
- `packages/dispatch/skills/autopilot/dashboard/dist/{app.js,index.html,modules/*.js}`
- `packages/monitor/skills/usage-dashboard/scripts/rollup-update.ts` — prior art for
  byte-offset transcript tailing (read for approach only; **do not import**)
