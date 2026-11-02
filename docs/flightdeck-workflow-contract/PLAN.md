# Flightdeck workflow contract

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-09-06

## Overview

Teach `flightdeck` to render any Claude Code Workflow-tool run, not just a
flightplan `tasks/` tree, by defining a declarative graph + event contract that
a workflow's author satisfies, and shipping a `dispatch:deckplan` reference
skill so Claude writes conforming workflows.

## Goals

- A workflow that declares `graph.json` and whose agents append to
  `.flightlog/run.jsonl` renders live in flightdeck — lanes, dependency graph,
  fleet table, and token attribution.
- autopilot's existing path keeps working, byte-identically, off shared types.
- `dispatch:deckplan` documents the authoring rules and ships one runnable
  example that also serves as the dashboard's fixture.

## Non-goals

- Migrating autopilot onto the contract. Its path is stable and heavily tested;
  it shares types only.
- Rendering a run post-mortem from `wf_<runId>.json`. That record has no
  dependency edges, and `/workflows` already covers most of what it can show.
- Incremental or dynamic graph growth. The graph is declared before the run.
- Any change to the panel's **visual language** — colour, shape, geometry, the
  berth plate, the signal head, the crossover curve. The renderer's design
  contract governs those and this work stays inside it.

  One frontend change is nonetheless in scope, and it is worth saying why the
  non-goal moved. The contract lets an author declare road order, and the lanes
  panel honors it — but the dependency graph derives its road order from the
  node list it sorts, so a declared order that is not alphabetical is silently
  re-sorted and a lane holding no node draws no road at all. Without that fix
  the contract promises something the panel breaks. The change takes the road
  order as an input instead of deriving it; nothing about how a road looks
  changes.

- Executing a real Workflow run as part of a task's own verification. Each task
  proves itself with unit tests and the committed fixture. One probe run of
  three agents was executed while writing this plan, to settle whether the
  prompt-text attribution join works at all; it does, and that answer is
  recorded under Open Questions. No task needs to repeat it.
- Cutting a dispatch release. That is a separate `/chronicle:release`.

## Context

flightdeck renders one thing today: a flightplan `tasks/` tree plus its
`.flightlog/` trail. The question that started this work was whether it could
render an ordinary Workflow-tool run instead.

It cannot, by reading what the harness already writes. Three findings, all
verified:

1. **A run's on-disk record has no dependency edges.**
   `~/.claude/projects/<proj>/<session>/workflows/wf_<runId>.json` carries
   `phases[]` and a rich `workflowProgress[]` — label, model, state, attempt,
   tokens, toolCalls, durationMs — but nothing that says agent B consumed
   agent A. Order lives only in the script's control flow (`await`, `pipeline`,
   `parallel`) and is gone once the run ends. flightdeck's entire layout is
   dependency depth on x and lane on y, so without edges the panel degrades to
   a swimlane chart and its lineage-hover interaction has nothing to light.

2. **That record is written once, at the terminal-state transition.** Progress
   updates an in-memory registry — what `/workflows` renders — and the file
   lands only when the run completes, fails, or is killed. Verified in the
   2.1.261 CLI bundle and by scanning 90 records: every `status` is
   `completed` / `failed` / `killed`, never `running`. The sibling
   `journal.jsonl` _is_ appended live, but each line is only
   `{type, key, agentId, result}` — no label, no phase, no state. An agent
   transcript's `slug` is the parent session's, identical across every agent in
   the run.

3. **A Workflow script has no filesystem access and cannot import.** Autopilot's
   own saved 655-line orchestrator uses exactly four globals — `agent`,
   `phase`, `parallel`, `pipeline` — and nothing else. Every side effect it
   causes goes through a spawned, tool-capable agent.

Together those force the shape of any solution: the graph must be **declared by
the author before the run**, and events must be **written by agents at run
time**. That is exactly what autopilot already does with a task tree and
`.flightlog/`. This work generalizes it into a contract, teaches flightdeck to
read it, and documents how to write one.

### The attribution constraint

Token attribution does not join on the event trail. `usage-source.ts:53-77`
regexes an agent's **first message** for `--task <ref> --role <role>` (and
`--attempt <n>`), and `decideMembership` additionally requires that message to
contain the plan directory's absolute path. Both are prompt-text conventions,
not schema.

`usage-source.ts:398-414` then maps a repo root — found by walking up from the
plan directory for `.git` — to `~/.claude/projects/<slug>/` to locate the
transcripts at all. Under this contract the run directory lives in XDG, outside
any repo, so that walk finds nothing and attribution would silently produce
zeroes. `graph.json` therefore declares `repoRoot` explicitly.

Every authoring rule in `deckplan` exists to satisfy these two facts. A workflow
that ignores them still renders — its token figures just read `N/A`.

## Requirements

### MVP

1. **`state` event kind** — the flightlog schema, CLI, and parser accept
   `{kind: "state", ts, task, state}`.
   - Acceptance: a `state` line round-trips through the CLI and `readLog`; an
     unknown `kind` is still dropped silently; autopilot's existing tests pass
     unchanged.
2. **Narrow `GraphNode` type** — the fields `deriveTaskViews` actually needs,
   extracted from `ParsedTask`, with the task-file loader producing it.
   - Acceptance: `deriveTaskViews` takes `GraphNode`, not `ParsedTask`;
     autopilot's tree renders identically; the whole autopilot suite passes.
3. **`graph.json` loader** — parses and validates the contract file into
   `GraphNode[]`, `lanes`, `title`, `repoRoot`.
   - Acceptance: a valid file loads; every malformed shape produces a named,
     non-throwing error surfaced in `TreePayload.errors`.
4. **Event-driven state derivation** — node state resolves from the trail alone.
   - Acceptance: the resolution order below is unit-tested, including the
     `invalid` cases.
5. **Source auto-detection** — `validatePlanDir` accepts a directory holding
   either `tasks/` or `graph.json`, and both API routes serve from whichever
   was found.
   - Acceptance: an autopilot plan dir and a contract dir both serve
     `/api/tree` and `/api/events`; a directory with neither is rejected with a
     message naming both.
6. **`repoRoot` honored** — transcripts are located from `graph.json`'s
   `repoRoot` rather than a walk-up.
   - Acceptance: a fixture repo root outside the run directory resolves the
     transcript directory; the autopilot path still walks up as before.
7. **Declared lane order reaches the dependency graph** — the panel draws its
   roads in the declared order, and draws a road for a lane holding no node.
   - Acceptance: a non-alphabetical declared order survives to the rendered road
     sequence; an empty declared lane gets a road; with no order supplied the
     layout is identical to today's.
8. **`dispatch:deckplan`** — the authoring reference plus one runnable example.
   - Acceptance: the example's `graph.json` and hand-written trail render every
     panel when flightdeck is pointed at it.

### Later

- **Re-proving attribution once the run directory moves out of the repository** —
  the join itself is measured and works; what stays untested is the same join
  anchored by a declared repository root. Re-run the probe after that lands.
- **A `--list` of runs under the XDG root** — the skill prints the full command
  instead.

## Tech decisions

- **Stack**: Bun + TypeScript, no transpile step, no runtime npm dependencies.
- **Storage**: `~/.local/share/q-lab/flightdeck/<slug>/` holding `graph.json`
  and `.flightlog/run.jsonl`. Fixed slug; confirm before overwriting an
  existing trail.
- **Deployment**: ships inside the `dispatch` plugin; no build artifacts.
- **Conventions**: see `_context/shared.md`. The schemas every task must agree
  on are in `_context/contract.md`.

## Architecture

```
authoring time                     run time                    read time
──────────────                     ────────                    ─────────
deckplan skill                     Workflow script             flightdeck
  │                                  │ (no fs, no imports)       │
  │ author writes                    │                           │
  ▼                                  ▼                           │
graph.json  ─────────────────►   agent(prompt)                   │
  nodes/edges/lanes                  │                           │
  repoRoot                           │ Bash                      │
                                     ▼                           │
                              .flightlog/run.jsonl ──────────────┤
                                 note / score / state            │
                                                                 ▼
                                                        validatePlanDir
                                                          ├── tasks/     → task-file loader
                                                          └── graph.json → contract loader
                                                                 │
                                                                 ▼
                                                          GraphNode[] ──► buildTreePayload
                                                                          eventsHandler
```

Both loaders converge on `GraphNode[]`; everything downstream —
`buildTreePayload`, `deriveTaskViews`, `summarizeWaves`, `aggregateFleet`, the
SSE tail, and all of the frontend except the graph panel's road ordering — is
reused unchanged.

## Bucketing

- **Strategy**: layer, in dependency order.
- **Why**: the shared schema must settle before either consumer can be written,
  and the two consumers (the dashboard, the skill) are independent of each
  other once it has.

### Buckets

- **`contract/`** — the shared schema layer: the new event kind, the narrow
  node type, and the specification document. Starts first; everything else
  depends on it.
- **`deck/`** — flightdeck reading the contract: loader, state derivation,
  routing, transcript anchoring.
- **`skill/`** — `dispatch:deckplan`: the authoring reference and the runnable
  example that doubles as the fixture.
- **`review/`** — the closing final-review task.

## Task index

| Bucket   | NN  | Title                | Status | Pass line | Depends on                     |
| -------- | --- | -------------------- | ------ | --------- | ------------------------------ |
| contract | 01  | state-entry-kind     | todo   | > 4.0     | —                              |
| contract | 02  | graph-node-type      | todo   | > 4.0     | contract/01                    |
| contract | 03  | contract-spec        | todo   | > 4.0     | contract/01, contract/02       |
| deck     | 01  | graph-json-loader    | todo   | > 4.0     | contract/02, contract/03       |
| deck     | 02  | state-derivation     | todo   | > 4.0     | contract/01, deck/01           |
| deck     | 03  | source-autodetect    | todo   | > 4.0     | deck/01, deck/02               |
| deck     | 04  | transcript-repo-root | todo   | > 4.0     | deck/01, deck/03               |
| deck     | 05  | declared-lane-order  | todo   | > 4.0     | deck/03                        |
| skill    | 01  | deckplan-reference   | todo   | > 4.0     | contract/03                    |
| skill    | 02  | example-workflow     | todo   | > 4.0     | skill/01, deck/04, deck/05     |
| review   | 01  | final review 🏁      | todo   | > 4.0     | contract/03, deck/04, skill/02 |

## Cross-bucket dependencies

```
                                                                  ┌── deck/04 ──┐
contract/01 ── contract/02 ── contract/03 ──┬── deck/01 ── deck/02 ── deck/03 ──┴── deck/05 ──┐
                                            │                                                 ├── skill/02 ── review/01
                                            └── skill/01 ────────────────────────────────────┘
```

`contract/01` and `contract/02` are **sequenced, not because the second needs
the first's output, but because both edit `fleet.ts` and its test.** A wave
dispatches every ready task into one shared working tree and forbids each of
them to commit, so two tasks editing one file in the same wave clobber each
other. That is a scheduling constraint, not a logical dependency — and it is the
reason the first wave holds exactly one task.

`deck/` then runs in sequence up to the source detection, after which the
transcript anchoring and the lane-order fix are independent and fly together —
their file lists do not overlap. `skill/01` can be written the moment
`contract/03` lands, in parallel with the whole `deck/` chain; `skill/02` waits
for the chain and the reference both, because it has to render against the real
loader and the real panel.

## Node state resolution

The one rule every consumer must agree on, restated here because it is the
contract's only piece of real logic:

1. The **latest `state` entry** for the node wins.
2. Otherwise an **unclosed `start` note** reads `in-progress`.
3. Otherwise a node with any **incomplete dependency** reads `blocked`.
4. Otherwise `ready`.
5. A node whose latest `state` entry carries a value outside the known set reads
   `invalid`.

An event naming a `task` that is not a node in the graph is a separate case, not
rule 5: there is no node to mark, so nothing changes state and the event is
reported as an error. `invalid` is counted separately, and a payload carrying
errors is not read as a clean run, so the dashboard can never present the run as
complete while either kind of problem exists — the same guarantee autopilot's
tree already makes.

A dangling `dependsOn` ref is removed from the node's dependency array and
reported, so the layout and the readiness rule agree. Leaving it in would block
the node forever on something that does not exist.

## Open questions

1. ~~**Does live token attribution actually survive the contract?**~~
   **Answered, by measurement.** A three-agent Workflow run against a scratch
   directory inside the repository, with prompts following the announce
   convention, produced three discovered transcripts, three correct
   node/role/attempt parses, and three joined rows carrying real token figures.
   The convention holds.

   The same trail outside a repository found zero transcripts and reported a run
   that spent nothing, silently — which is the premise `deck/04` is built on,
   now measured rather than assumed. Re-run the check once that task lands.

2. **A dispatch version bump** is out of scope here and belongs to a separate
   `/chronicle:release` once this ships.

## Known gaps

Populated after the review loop; see `tasks/README.md` for the live list.

## References

- `packages/dispatch/skills/autopilot/DESIGN.md` — the panel's design contract
- `packages/dispatch/skills/autopilot/references/orchestrator.md` — how
  autopilot's agents announce and log, the model this contract generalizes
- `docs/flightdeck/`, `docs/flightdeck-tokens/` — prior flightdeck work
