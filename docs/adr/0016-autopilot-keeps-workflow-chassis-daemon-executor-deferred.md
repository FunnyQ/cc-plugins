# ADR-0016: Autopilot keeps the Workflow-tool chassis; daemon executor deferred

- Status: Accepted
- Date: 2026-08-01

## Context

Much of `orchestrator.md`'s unusual design (baked absolute paths, CFG baking,
"fan-out must happen in the orchestrator") traces back to limitations of the
Workflow tool itself, not to any requirement of the task-execution domain:
scripts have no filesystem access, agents share no cwd, agents have no
`Agent` tool of their own, and the `args` global is unreliable.

## Considered alternatives

- Replace the Workflow-tool chassis with a persistent daemon scheduler.
  `fleet.ts` already imports `unmetDependencies` and `taskValidity`, meaning
  much of a scheduler is effectively half-written, and the flightdeck daemon
  today is only a read-only observer. Not adopted for this pass: it would
  drop the `/workflows` progress UI and `resumeFromRunId`, and amounts to a
  full rewrite rather than an incremental change.

## Decision

Keep the Workflow-tool chassis. The daemon-executor alternative is recorded
as a deferred future waypoint (`docs/autopilot-graph/PLAN.md`), not adopted
in this decision. Status here is `Accepted` specifically for "keep the
Workflow-tool chassis" — the deferred daemon-executor alternative is future
context, not a blocking condition on this record.

## Consequences

Every currently-odd pattern in `orchestrator.md` (path baking, CFG baking,
orchestrator-only fan-out) remains explained by, and justified by, Workflow
tool limitations rather than domain necessity — this is the load-bearing
architecture explanation for dispatch's primary execution engine. A future
daemon-executor rewrite is expected but not scheduled; when it lands, it
would remove the constraints this ADR documents, not the underlying
scheduling logic (`unmetDependencies`, `taskValidity`), which was already
written once for `fleet.ts`.

## Evidence

- **Nine-tenths of orchestrator.md's odd design traces to tool limits, not
  domain need** — no filesystem access in scripts, no shared cwd between
  agents, no `Agent` tool inside an agent, and an unreliable `args` global
  together explain path baking, CFG baking, and orchestrator-only fan-out. A
  daemon-scheduler alternative (`fleet.ts` already imports
  `unmetDependencies`/`taskValidity`) was evaluated and deliberately deferred
  to a future waypoint rather than adopted now, since it would drop
  `/workflows` UI and `resumeFromRunId` and requires a full rewrite.
  Session `ddc10dec-a0d5-4cb6-b529-88ae4d847a1e`, entry `27cfe4f5-b471-4cc3-855c-d24e93a5f53d`, 2026-08-01.
