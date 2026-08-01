# autopilot orchestrator — graph hardening

> **Status**: draft — revised after a codex cross-vendor review
> **Owner**: Q
> **Last updated**: 2026-08-01

## Overview

Targeted changes to the autopilot orchestrator graph. The current shape — a deterministic scheduler
driving stateless LLM workers over a filesystem state machine — is correct and stays. These changes
close one correctness hole, remove the last interpreting step from the control path, and give commits
a failure channel and an audit trail.

## Goals

- Guarantee the closing gate runs a real regression net, so the Final review fixer's edits are tested.
- Reduce the scout agent to transcription. It should not transform.
- Give the commit step a failure channel and a flightlog entry. Leave its grouping and its prose alone.
- Keep every change verifiable through the existing `orchestrator-script.test.ts` fixture.

## Non-goals

- **Replacing the Workflow tool with a scheduling daemon. Decided against, not deferred.** Most of the
  awkwardness in `orchestrator.md` comes from Workflow constraints, not from the domain: no filesystem
  access in the script, no shared cwd between agents, no `Agent` tool inside an agent, unreliable
  `args`. A daemon executor would delete most of that file, and `fleet.ts` already imports
  `unmetDependencies` and `taskValidity`, so half the scheduler exists. It still gives up `/workflows`
  progress and `resumeFromRunId` for a full rewrite. **The Workflow chassis stays.** Every change in
  this plan is designed to live within its constraints permanently, not as a stopgap.
- **`isolation: 'worktree'` for dev agents.** `orchestrator.md:771` records why it breaks every run.
- **A multi-judge voting panel.** The dev ≠ judge split is sufficient. Add reviewers only if scoring
  is measured to be unstable.
- **Critical-path scheduling.** Trees run 8–20 tasks. The gain is zero.

## Context

The current graph, as of `packages/dispatch/skills/autopilot/references/orchestrator.md`:

```
main agent (inline scout) → Workflow({ script })
  └─ while(true) wave loop                       ← barrier per wave
       ├─ [wave>1, no escalations] commit preamble  ← bolted onto the scout prompt
       ├─ scout (haiku, SCOUT_SCHEMA)               ← echoes next-ready.ts --summary
       └─ parallel( fresh.map(runTaskGuarded) )     ← shared working tree, no isolation
            └─ executeTask (attempt 1..cap)
                 ├─ dev | external driver | runFinalReview (5 lenses → opus fixer)
                 ├─ verify (haiku, GATE_SCHEMA)
                 ├─ judge  (opus,  JUDGE_SCHEMA)
                 └─ mark-done (haiku, confirmed by reread)
  post-loop commit (haiku, only when escalations == 0)
```

Three properties are load-bearing and stay: completion lives on disk (`counts.done`, never
`completed.length`); readiness is recomputed every wave from `next-ready.ts`; every status transition
is confirmed by rereading the file.

### Verified defects

| # | Defect | Evidence |
|---|---|---|
| D1 | Nothing guarantees the closing gate runs a test suite, so the Final review fixer's edits — the last writes in the run — can ship unverified. | Each task verifies only itself; `next-ready.ts:223-230` and `orchestrator.md:666-670` exclude done tasks from any re-offer. The final-review verifier runs only that task's own `## Verification` (`orchestrator.md:373-384`), and the fixer edits code after every wave has finished (`:347-360`). Cross-coverage from path-scoped test commands is incidental: in `docs/waypoints-skill/tasks/`, only the final-review task ran any test at all. |
| D2 | The scout agent still transforms: it maps `invalid[].ref → invalidRefs`, and the schema carries a defensive `required` list to stop it summarizing `errors` away. | `orchestrator.md:602-610`, `:127-178`. **Not** evidence of a current failure — the whole-tree re-listing incident belongs to the retired line-oriented scout (`orchestrator.md:747`). This is residual trust surface, not a demonstrated bug. |
| D3 | Inter-wave commits ride the scout prompt under `SCOUT_SCHEMA`, which has no commit-outcome field. A blocked commit is unreportable. | `orchestrator.md:587-612`; `SCOUT_SCHEMA` at `:127-178`; downstream logic reads only tree fields (`:614-655`). |
| D4 | No commit path calls `flightlog.ts`, so commits never enter the audit trail. | `orchestrator.md:593-612`, `:721-730`. The dashboard side is already built — `fleet.ts:12-25` knows the `commit` role, `:127-129` parses `commit-post-loop`, `:262-267` falls back to the entry's role. **Only emission is missing.** |
| D5 | After the first escalation, no wave commits again and the post-loop commit is skipped. Later successes accumulate in one dirty tree. | The same `escalations.length === 0` guard at `:589-595` and `:721-730`. **Not scheduled for a fix.** The guard is deliberate: rejected and in-flight edits share one tree (`:589-592`). Listed here so the dirty tree is a known cost, not a surprise. |
| D6 | An empty-but-existing `tasksDir` reports clean completion, then the post-loop commit sweeps the working tree into a commit. | `next-ready.ts:64-112` returns empty maps for a readable empty dir; `:181-220` leaves counts at zero; `orchestrator.md:658-664` reads `0 === 0` as complete. Reproduced by running `next-ready.ts <empty dir> --summary` → exit 0, all counts zero. |

## Requirements

### MVP

#### R1 — require a regression net in the Final review task

Closes D1. **A `lint-task.ts` rule and template guidance. No new script, no orchestrator change.**

The rejected design was a `verify-all.ts` that re-executes every done task's verification items.
Sampling real trees killed it. Items are written as *a backticked command plus a prose assertion*:

```
- [x] `grep -c waypoints packages/dispatch/.claude-plugin/plugin.json` is ≥ 2 (description + keyword).
- [x] `git status` shows the marketplace registry files unmodified.
```

The assertion lives in the prose, not in the exit code. `grep -c` exits 0 on one match while the
criterion demands two; `git status` always exits 0. Mechanical re-execution would therefore report
**false greens**, and a false green at the closing gate is worse than no re-verification at all — it
stamps a broken tree as passed. `ParsedTask` also exposes no command AST to build on
(`parse-task.ts:25-50`; `extractHeadingSection` is private at `:253`).

The real gap is narrower than "nothing re-verifies". `docs/waypoints-skill/tasks/integration/03-final-review.md`
already carries `` `bun test packages/dispatch/skills/waypoints/scripts/ .../flightplan/scripts/` green `` —
that *is* a cross-task regression net. Nothing requires it.

**Why the Final review specifically, when each wave already verifies.** Each task runs only its own
`## Verification`; nothing re-runs another task's. Cross-coverage happens incidentally, because test
commands are path-scoped — a wave-3 `bun test <dir>` sweeps up wave-1 code for free. That incidental
net is real but unreliable: in the sampled tree, tasks 01 and 02 ran only `grep` and `JSON.parse`.

The case no wave can cover is the **Final review fixer**. It is the last writer in the run
(`orchestrator.md:347-360`), applying five lenses' findings with Edit/Write after every wave has
finished. Its edits are gated only by the Final review task's own Verification. With no test command
there, the run's last code changes ship unverified, and no earlier wave can help — they already ran.

So the rule is conditional on the tree, not a blanket policy:

- New `lint-task.ts` rule: **if any task in the tree has a `## Verification` item whose backticked
  command matches a known test-runner pattern** (`bun test`, `npm|pnpm|yarn test`, `cargo test`,
  `pytest`, `go test`, `rspec`, `make test`), **then the `> **Final review**: true` task must have one
  too.** A tree that never runs a test — a docs-only plan — triggers nothing and stays silent.
- Severity: error when the condition fires. The tree has proven it has a suite; the closing gate
  skipping it is a defect, not a style choice.
- Separate **informational** report, never affecting exit code: list the path arguments of every test
  command across the other tasks alongside the Final review task's, so a planner can eyeball reach.
  Breadth is not mechanically decidable from a command string — lint enforces presence, a human
  judges reach.
- Update `flightplan/references/task-template.md` (the `Final review` section) and
  `flightplan/SKILL.md:75`, so plans are written this way rather than corrected by lint.

- Acceptance: a tree with test commands elsewhere but none in the Final review task fails lint,
  naming the rule and the tasks whose tests it is missing.
- Acceptance: a tree with no test command anywhere passes silently.
- Acceptance: a non-final-review task with no test command always passes — the rule is scoped.
- Acceptance: the informational report lists other tasks' test paths and does not affect exit code.
- Acceptance: every existing tree under `docs/` is linted; any failure is a real missing net, and is
  reported rather than silently accepted.

Deferred upgrade path: if presence proves too weak, have the Final review verifier agent read each
done task's Verification section and re-check the prose assertions itself. That keeps the LLM in the
loop where the assertions actually live, at a token cost linear in tree size.

#### R2 — the scout transcribes, the script interprets

Closes D2 and D6.

- `SCOUT_SCHEMA` becomes `{ stdout: string, exitCode: number, stderr: string }`.
- The scout prompt reduces to: run exactly this command, return stdout verbatim, plus exit code and
  stderr.
- The orchestrator does `JSON.parse(scout.stdout)` and derives every field in plain JS. This is a
  pure in-memory operation, so it needs no Workflow filesystem access.
- A parse failure or a missing field becomes an explicit `(scout)` escalation.
- Every existing guard keeps its order and semantics. Only the source of the values changes.
- Add the D6 guard in the same block: `counts.total === 0` escalates instead of reporting complete.

- Acceptance: `orchestrator-script.test.ts` passes. Its stub contract changes — it currently returns
  already-interpreted `ScoutResult` objects (`orchestrator-script.test.ts:34-42`) and must return raw
  stdout strings.
- Acceptance: a stub returning non-JSON stdout produces a `(scout)` escalation, not an empty run.
- Acceptance: a stub returning `total: 0` escalates.

#### R3 — give the commit step its own agent

Closes D3 and D4. **Deliberately does not change what gets committed, who writes the message, or the
`escalations.length === 0` guard.**

An LLM keeps writing the commit message from the real diff. Commit `6d0363ed` is the evidence: its
body names "`unmetDependencies` exported for external callers (fleet integration)" — a fact that
exists only in the diff, never in a task header. Deriving messages from plan-time metadata would be
strictly worse.

Wave-level atomic grouping also stays. That same commit spans two scripts as one coherent change. A
per-task commit staging only one task's declared file list would have split it. The commit agent sees
the whole wave's diff and groups it, which is what `COMMIT_INSTRUCTIONS` already asks for.

The change is only that the commit stops being a passenger on the scout:

- Extract `commitPreamble` from the scout prompt into its own `agent()` call on `MODEL.commit` rather
  than `MODEL.verify`, and **move it after every scout guard**, immediately before the `parallel()`
  dispatch.

  Ordering is load-bearing. Today the commit runs before the scout, so a wave that corrupted a task
  file gets that corruption committed — and described by the commit agent as an intentional change —
  before the scout reports `errors` or `invalid > 0` and aborts the run. Committing into a tree the
  next guard is about to call untrustworthy is what the `escalations.length === 0` guard exists to
  prevent; the guard just cannot see a defect the scout has not found yet. Running after the guards
  also removes a redundant commit on the `done === total` path, where the post-loop commit already
  covers the last wave.
- Give it `COMMIT_SCHEMA = { committed: boolean, shas: string[], failed: boolean, reason: string }`.
  A blocked hook or a conflict now has somewhere to land.
- A `failed: true` result becomes an escalation. Today it is unreportable.
- Add one line to `COMMIT_INSTRUCTIONS`: after committing, append a flightlog entry with
  `--role commit`. That is the whole of D4 — `fleet.ts` already renders the role
  (`fleet.ts:12-25`, `:127-129`, `:262-267`), only emission is missing.
- Apply the same treatment to the post-loop commit, which has the identical blind spot.
- `SCOUT_SCHEMA` and the scout prompt return to describing the tree and nothing else.

- Acceptance: a wave whose commit fails (simulate with a rejecting `pre-commit` hook) produces an
  escalation naming the git error, and does not report a clean run.
- Acceptance: `fleet.ts` renders `role: commit` entries from a real run's flightlog.
- Acceptance: the scout prompt contains no commit text, and `SCOUT_SCHEMA` is unchanged by R3.

**Rejected — per-task commits via a `commit-task.ts`.** It needs a commit-serialization slot plus an
in-flight file-overlap check to be safe, because `git add <path>` stages whatever that path holds at
that moment and same-wave pipelines share one working tree (`orchestrator.md:686-689`). That is a
large amount of machinery whose payoff is worse commit grouping than the current step already
produces. D5 stays as designed: after an escalation, rejected and in-flight edits share the tree, so
not committing is the safe behaviour (`orchestrator.md:589-592`), and the cost is a dirty tree the
user resolves by hand.

### Later

#### R4 — continuous scheduling instead of waves

Replace the wave barrier with an in-flight set. Re-scout whenever any task settles.

```js
const inflight = new Map()
while (true) {
  const tree = await scout()
  for (const t of readyOf(tree)) if (!inflight.has(t.ref)) inflight.set(t.ref, runTaskGuarded(t))
  if (!inflight.size) break
  const settled = await Promise.race([...inflight.values()])
  reconcile(settled); inflight.delete(settled.task)
}
```

Termination becomes "nothing in flight and nothing ready", replacing the `!passedThisWave` heuristic.
Cost: one scout per settlement instead of per wave — a haiku agent and one Bash call.

Note: `wave` survives in the codebase only as a number parsed off the scout's label
(`fleet.ts:32`, `:89`, `:125`). Nothing downstream reads it, and the dashboard never renders it. A
label change would simply leave the field undefined, so the vocabulary is not a constraint here.

**Blocked on a commit point, and that may be fatal to R4.** Waves provide a consistency barrier for
free: the commit runs in the gap after one batch finishes and before the next starts. Continuous
scheduling deletes that gap, so every commit lands while other tasks are mid-write. The three
candidates are all poor:

| Commit point | Problem |
|---|---|
| Every settlement (e.g. alongside the scout) | Per-task granularity — the grouping R3 rejected — plus the contamination risk, and it re-couples commit to scout, undoing R3. |
| Whenever in-flight drains to zero | Safe, but the better R4 schedules, the rarer a drain becomes. |
| Once at the end | Safe and simple. Costs one large dirty tree for the whole run. |

So R4 buys wall-clock and pays in commit coherence — the exact property R3 was scoped to protect
(`6d0363ed` is a wave-grouped commit spanning two scripts). At 8–20 tasks the parallelism gain is
modest.

**R4 is therefore not planned.** Revisit only if a real run shows wave barriers materially stalling —
a slow task visibly holding ready dependents idle. If it is ever built, "once at the end" is the
commit point.

**Blocking unknown, if it is ever revisited**: `Promise.race` is unverified inside the Workflow
runtime. Prove it in the fixture first.

#### R5 — better retry ladder

- Accumulate `attempts: [{ n, model, gateSummary, rationale, weighted }]` and render the whole history
  into the retry prompt. Today only the last rejection survives, so attempt 3 cannot see what attempt
  1 already tried, and repeatedly fixes A while breaking B.
- End every ladder with a vendor switch. An external `devEngine` already falls back to Claude-Opus on
  the last shot. `devEngine: 'claude'` only escalates sonnet → opus, the same vendor.

#### R6 — budget floor

Read the Workflow `budget` global. Below a floor, stop dispatching new tasks and let in-flight ones
finish. Never park mid-task on budget — that manufactures a new unknown state.

## Risks

- **R1 enforces presence, not reach.** A Final review task can satisfy the rule with
  `bun test one/narrow/dir` and still miss most of the tree. The informational report is the only
  countermeasure, and it needs a human to read it. Accepted: a weak net that always exists beats a
  strong one that sometimes does not.
- **R1 may fail lint on existing trees.** That is the point — each failure is a real missing net. But
  it will surface at an inconvenient moment for someone mid-plan.
- **Fixture drift (all).** `orchestrator-script.test.ts` extracts the fenced block from
  `orchestrator.md` verbatim. Every change must land in that block, not beside it.

## Landing order

All three are independent, and R1 no longer touches the orchestrator at all — it is a `lint-task.ts`
rule plus template guidance, so it can land at any time, in parallel with the others.

For the two that do touch the orchestrator: `R3 → R2`. R3 is the smaller (one agent split, one
schema, one prompt line) and both edit the same wave loop and the same fixture, so landing R3 first
avoids a mechanical conflict.

## Verification

```bash
bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts
bun test packages/dispatch/skills/flightplan/scripts/
# R1: lint every existing tree — each failure is a real missing regression net
for t in docs/*/tasks; do bun packages/dispatch/skills/flightplan/scripts/lint-task.ts "$t"; done
```

Full proof needs one real `/autopilot` run over a small tree, checking that the flightlog carries
`role: commit` entries and that `fleet.ts` renders them.

## Open questions

None. The three that stood here are resolved:

- **Commit point under continuous scheduling** — answered inside R4, and the answer demoted R4 to
  not-planned.
- **Wave vocabulary after R4** — dissolved. Nothing consumes the parsed `wave` field.
- **Daemon executor** — decided against. The Workflow chassis stays; see Non-goals.

The one thing left is empirical, not a decision: does a real run visibly stall on wave barriers? If
it does, R4 comes back with "commit once at the end".

## Review log

- **2026-08-01, codex (cross-vendor, read-only sandbox)** — confirmed D1, D3, D4, D5, D6. Corrected
  D2: the re-listing incident belongs to the retired line-oriented scout, not the current one.
  Confirmed R1–R3 violate no Workflow constraint. Found two blocking gaps, both folded in above:
  R1 had no executable command grammar, and R3's cross-task contamination is a correctness problem
  that index-lock retries cannot fix. Corrected the R4→R3 dependency claim.
- **2026-08-01, Q** — scoped R3 down to an agent split. Two calls: the commit message keeps being
  written by an LLM from the real diff (evidence: `6d0363ed`), and per-task commit boundaries are
  rejected because wave-level grouping produces better commits than a task's declared file list can.
  D5 reclassified from a defect to a known cost. R3 became the smallest item, so the landing order
  reversed.
- **2026-08-01, Q** — replaced R1's `verify-all.ts` with a lint rule. Sampling real trees showed
  verification items carry their assertion in prose, not in the exit code, so mechanical re-execution
  would report false greens. Q then rejected a blanket "must", correctly noting waves already verify;
  the rule became conditional on the tree already containing a test command, and D1 was re-scoped to
  the case waves genuinely cannot cover — the Final review fixer's post-wave edits.
- **2026-08-01, Q** — settled every open question. The Workflow chassis stays permanently, so the
  daemon executor moved from deferred to rejected. Working the commit-point question demoted R4 to
  not-planned: continuous scheduling trades commit coherence for wall-clock, and coherence is what R3
  exists to protect. The wave-vocabulary question dissolved on inspection — `fleet.ts` parses a wave
  number that nothing reads.
- **2026-08-01, Q** — moved the commit agent after the scout guards. The draft had kept it before the
  scout, inheriting the current position without a reason. Q was right: committing first lets a
  corrupted task file reach git before the scout reports it.
