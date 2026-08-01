# autopilot orchestrator — graph hardening (executable plan)

> **Status**: ready to execute
> **Owner**: Q
> **Last updated**: 2026-08-01
> **Supersedes**: an earlier design spec at `docs/autopilot-graph/PLAN.md`, since removed. Its content is
> carried forward here; the original text is recoverable with
> `git show a53b5de:docs/autopilot-graph/PLAN.md`. The one thing not carried forward is R4's
> continuous-scheduling code sketch (an in-flight `Map` driven by `Promise.race`) and the observation that
> `fleet.ts` parses a `wave` number nothing downstream reads — both concern R4, which is rejected below.
> Start from that commit if R4 is ever revisited.

## Overview

Targeted changes to the autopilot orchestrator graph. The current shape — a deterministic scheduler
driving stateless LLM workers over a filesystem state machine — is correct and stays. These changes
close two correctness holes, remove the last interpreting step from the control path, give commits a
failure channel and an audit trail, make the retry ladder learn across attempts, and let a run stop
cleanly on budget.

Five requirements ship: **R1, R2, R3, R5, R6**. R4 is rejected, not deferred.

## Goals

- Stop a tree that owns a test suite from shipping a closing gate that runs no test at all. This is a
  **presence** guarantee, deliberately not a coverage one: it removes the case where the Final review
  fixer's post-wave edits are gated by zero tests, and does not claim those edits are well covered. Reach
  is advisory (see the report in R1) because it is not mechanically decidable from a command string.
- Reduce the scout agent to transcription. It should not transform.
- Give the commit step a failure channel and a flightlog entry. Leave its grouping and its prose alone.
- Make a retry see every prior attempt. This part is unconditional and applies to every run.
- Make it *possible* for a Claude ladder to end on a genuine vendor switch. **Opt-in**, off by default:
  the rung only exists once `CFG.lastShotEngine` names an engine. With the default the ladder stays
  sonnet → sonnet → opus, unchanged. Off by default because the rung costs a whole extra attempt per
  failing task, and that is the operator's call to make, not a silent new default.
- Make a reported between-waves stopping point available to a run that declares a token budget.
  **Opt-in**, and it needs *both* conditions: a declared budget (`budget.total` non-null) **and** a
  non-zero `CFG.budgetFloor`. Declaring a budget alone changes nothing. Best-effort even when enabled: the
  check compares the remaining balance against the floor and does not estimate the next wave's cost, so a
  dispatched wave can still exhaust the budget while running. It bounds and reports the stop; it does not
  prevent it.
- Keep every change verifiable through the existing `orchestrator-script.test.ts` fixture.

## Non-goals

- **Replacing the Workflow tool with a scheduling daemon. Decided against, not deferred.** Most of the
  awkwardness in `orchestrator.md` comes from Workflow constraints, not from the domain: no filesystem
  access in the script, no shared cwd between agents, no `Agent` tool inside an agent, unreliable
  `args`. A daemon executor would delete most of that file, and `fleet.ts` already imports
  `unmetDependencies` and `taskValidity`, so half the scheduler exists. It still gives up `/workflows`
  progress and `resumeFromRunId` for a full rewrite. **The Workflow chassis stays.** Every change in
  this plan is designed to live within its constraints permanently, not as a stopgap.
- **R4 — continuous scheduling instead of waves. Rejected.** Waves provide a consistency barrier for
  free: the commit runs in the gap after one batch finishes and before the next starts. Continuous
  scheduling deletes that gap, so every commit would land while other tasks are mid-write. All three
  candidate commit points are poor — per-settlement re-couples commit to scout and gives the per-task
  granularity R3 rejects; drain-to-zero gets rarer the better R4 schedules; once-at-the-end costs one
  large dirty tree. So R4 buys wall-clock and pays in commit coherence, which is the exact property R3
  exists to protect. At 8–20 tasks the parallelism gain is modest. Revisit only if a real run shows a
  slow task visibly holding ready dependents idle; if it is ever built, "once at the end" is the commit
  point, and `Promise.race` must be proven inside the Workflow runtime first.
- **`isolation: 'worktree'` for dev agents.** `orchestrator.md` records why it breaks every run.
- **A multi-judge voting panel.** The dev ≠ judge split is sufficient. Add reviewers only if scoring
  is measured to be unstable.
- **Critical-path scheduling.** Trees run 8–20 tasks. The gain is zero.
- **Per-task commits.** See the R3 rejection note.
- **A version bump or CHANGELOG entry.** These changes are served to every session from the marketplace
  clone tracking `main`, so the orchestrator cannot cut the release that fixes itself. Release by hand
  with `/chronicle:release` after this tree lands.

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
| D1 | Nothing guarantees the closing gate runs a test suite, so the Final review fixer's edits — the last writes in the run — can ship unverified. | Each task verifies only itself; `next-ready.ts` excludes done tasks from any re-offer. The final-review verifier runs only that task's own `## Verification`, and the fixer edits code after every wave has finished. Cross-coverage from path-scoped test commands is incidental: in `docs/waypoints-skill/tasks/`, only the final-review task ran any test at all. |
| D2 | The scout agent still transforms: it maps `invalid[].ref → invalidRefs`, and the schema carries a defensive `required` list to stop it summarizing `errors` away. | **Not** evidence of a current failure — the whole-tree re-listing incident belongs to the retired line-oriented scout. This is residual trust surface, not a demonstrated bug. |
| D3 | Inter-wave commits ride the scout prompt under `SCOUT_SCHEMA`, which has no commit-outcome field. A blocked commit is unreportable. | Downstream logic reads only tree fields. |
| D4 | No commit path calls `flightlog.ts`, so commits never enter the audit trail. | The dashboard side is already built — `fleet.ts` knows the `commit` role, parses `commit-post-loop`, and falls back to the entry's role. **Only emission is missing.** |
| D5 | After the first escalation, no wave commits again and the post-loop commit is skipped. Later successes accumulate in one dirty tree. | The same `escalations.length === 0` guard in both places. **Not scheduled for a fix.** The guard is deliberate: rejected and in-flight edits share one tree. Listed here so the dirty tree is a known cost, not a surprise. |
| D6 | An empty-but-existing `tasksDir` reports clean completion, then the post-loop commit sweeps the working tree into a commit. | `next-ready.ts` returns empty maps for a readable empty dir and leaves counts at zero; the orchestrator reads `0 === 0` as complete. Reproduced by running `next-ready.ts <empty dir> --summary` → exit 0, all counts zero. |
| D7 | A retry sees only the last rejection, so attempt 3 cannot know what attempt 1 already tried and repeatedly fixes A while breaking B. Its ladder also never leaves the vendor: `devEngine: 'claude'` escalates sonnet → opus only. | `executeTask` overwrites a single `feedback` string each attempt; the dev model is chosen by `attempt >= cap ? devEscalated : dev`, both Claude. |
| D8 | A declared token budget is invisible to the run. It can exhaust mid-task, which is the worst place to stop. | The orchestrator never reads the Workflow `budget` global. |

## Requirements

### R1 — require a regression net in the Final review task

Closes D1. **A `lint-task.ts` rule plus template guidance. No new script, no orchestrator change.**

The rejected design was a `verify-all.ts` that re-executes every done task's verification items.
Sampling real trees killed it. Items are written as *a backticked command plus a prose assertion*:

```
- [x] `grep -c waypoints packages/dispatch/.claude-plugin/plugin.json` is ≥ 2 (description + keyword).
- [x] `git status` shows the marketplace registry files unmodified.
```

The assertion lives in the prose, not in the exit code. `grep -c` exits 0 on one match while the
criterion demands two; `git status` always exits 0. Mechanical re-execution would therefore report
**false greens**, and a false green at the closing gate is worse than no re-verification at all — it
stamps a broken tree as passed. `ParsedTask` also exposes no command AST to build on, and
`extractHeadingSection` is private in `parse-task.ts`.

The real gap is narrower than "nothing re-verifies". `docs/waypoints-skill/tasks/integration/03-final-review.md`
already carries `` `bun test packages/dispatch/skills/waypoints/scripts/ .../flightplan/scripts/` green `` —
that *is* a cross-task regression net. Nothing requires it.

**Why the Final review specifically, when each wave already verifies.** Each task runs only its own
`## Verification`; nothing re-runs another task's. Cross-coverage happens incidentally, because test
commands are path-scoped — a wave-3 `bun test <dir>` sweeps up wave-1 code for free. That incidental
net is real but unreliable: in the sampled tree, tasks 01 and 02 ran only `grep` and `JSON.parse`.

The case no wave can cover is the **Final review fixer**. It is the last writer in the run, applying
five lenses' findings with Edit/Write after every wave has finished. Its edits are gated only by the
Final review task's own Verification. With no test command there, the run's last code changes ship
unverified, and no earlier wave can help — they already ran.

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
- Update `flightplan/references/task-template.md` (the `Final review` section) and the **Final review**
  bullet in `flightplan/SKILL.md`, so plans are written this way rather than corrected by lint.

Deferred upgrade path: if presence proves too weak, have the Final review verifier agent read each
done task's Verification section and re-check the prose assertions itself. That keeps the LLM in the
loop where the assertions actually live, at a token cost linear in tree size.

### R2 — the scout transcribes, the script interprets

Closes D2 and D6.

- `SCOUT_SCHEMA` becomes `{ stdout: string, exitCode: number, stderr: string }`.
- The scout prompt reduces to: run exactly this command, return stdout verbatim, plus exit code and
  stderr.
- The orchestrator does `JSON.parse(scout.stdout)` and derives every field in plain JS. This is a
  pure in-memory operation, so it needs no Workflow filesystem access.
- A parse failure or a missing field becomes an explicit `(scout)` escalation.
- **`exitCode !== 0` is not a failure condition.** `next-ready.ts --summary` prints its JSON *before*
  exiting 1 on an invalid or unparseable tree — that is deliberate, so the caller can name the invalid
  refs. Treating a non-zero exit as a scout failure would convert every malformed-tree run into a
  `(scout)` escalation and destroy the `invalid > 0` guard that reports which refs to reset. Parse stdout
  either way; `exitCode` and `stderr` are diagnostic context for the failure message, not a gate.
- Every existing guard keeps its order and semantics. Only the source of the values changes.
- Add the D6 guard in the same block: `counts.total === 0` escalates instead of reporting complete.

### R3 — give the commit step its own agent

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

- Extract the commit preamble from the scout prompt into its own `agent()` call on `MODEL.commit`
  rather than `MODEL.verify`, and **move it after every scout guard**, immediately before the
  `parallel()` dispatch.

  Ordering is load-bearing. Today the commit runs before the scout, so a wave that corrupted a task
  file gets that corruption committed — and described by the commit agent as an intentional change —
  before the scout reports `errors` or `invalid > 0` and aborts the run. Committing into a tree the
  next guard is about to call untrustworthy is what the `escalations.length === 0` guard exists to
  prevent; the guard just cannot see a defect the scout has not found yet. Running after the guards
  also removes a redundant commit on the `done === total` path, where the post-loop commit already
  covers the last wave.
- Give it `COMMIT_SCHEMA = { committed: boolean, shas: string[], failed: boolean, reason: string }`.
  A blocked hook or a conflict now has somewhere to land.
- A `failed: true` result, or no structured result at all, becomes an escalation. Today it is
  unreportable. **The loop continues** — the `escalations.length === 0` guard already stops every later
  commit, and breaking would abandon ready tasks over a git problem R3 is scoped not to re-litigate.
- Add one line to `COMMIT_INSTRUCTIONS`: after committing, append a flightlog entry with
  `--role commit`. That is the whole of D4 — `fleet.ts` already renders the role, only emission is
  missing.
- Apply the same treatment to the post-loop commit, which has the identical blind spot.
- `SCOUT_SCHEMA` and the scout prompt return to describing the tree and nothing else.

**Rejected — per-task commits via a `commit-task.ts`.** It needs a commit-serialization slot plus an
in-flight file-overlap check to be safe, because `git add <path>` stages whatever that path holds at
that moment and same-wave pipelines share one working tree. That is a large amount of machinery whose
payoff is worse commit grouping than the current step already produces. D5 stays as designed: after an
escalation, rejected and in-flight edits share the tree, so not committing is the safe behaviour, and
the cost is a dirty tree the user resolves by hand.

### R5 — better retry ladder

Closes D7. Two parts, one section of `executeTask`.

- Accumulate `attempts: [{ n, model, gateSummary, rationale, weighted }]` and render the whole history
  into the retry prompt. Today only the last rejection survives, so attempt 3 cannot see what attempt
  1 already tried, and repeatedly fixes A while breaking B.
- End the Claude ladder with a real vendor switch. An external `devEngine` already falls back to
  Claude-Opus on its last shot; `devEngine: 'claude'` only escalates sonnet → opus, the same vendor.
  **Append** a rung rather than replacing one: a new `CFG.lastShotEngine` (`'codex' | 'opencode' | ''`,
  empty = off) makes the effective cap `MAX + 1` when it is set **and** `devEngine` is `'claude'`, with
  that final attempt running the external dev driver. Opus therefore still gets its shot — replacing
  the Opus rung instead would lose every task only Opus clears.

  **The trap that makes "append" collapse into "replace".** The Claude escalation tier is chosen by
  `attempt >= cap ? MODEL.devEscalated : MODEL.dev`. Raise `cap` to `MAX + 1` and that test is false at
  `attempt === MAX`, so the ladder runs sonnet, sonnet, sonnet, external and Opus never executes at all —
  silently delivering the rejected design. The escalation tier must therefore key off a separate
  `claudeCap = cap - (lastShotEngine ? 1 : 0)`, not off `cap`.

Scoped to the non-finalReview ladder. `finalReview` keeps `FINAL_MAX` and its own multi-lens fan-out,
which is already cross-vendor.

### R6 — budget floor

Closes D8.

Read the Workflow `budget` global. Below a floor, stop dispatching new tasks and let in-flight ones
finish. Never park mid-task on budget — that manufactures a new unknown state.

- New `CFG.budgetFloor`, default `0` = off. `budget.total` is `null` unless the user declared a
  `+500k`-style target, so a nonzero default would be dead config on most runs, and a floor that fires
  unannounced manufactures a new stall class.
- Read `budget` defensively: it is absent in the test fixture, and `budget.total` is `null` with no
  declared target.
- The check sits **after** the commit agent and **before** the `parallel()` dispatch. Ordering is
  load-bearing: the wave that just finished still gets committed, and because a wave is a barrier
  nothing is in flight at that point, so "let in-flight finish" needs no extra machinery.
- Stopping produces a `(budget)` escalation, not a clean return. A run that stops with unfinished tasks
  and reports clean is exactly the silent-failure class the rest of this graph is built against.

## Bucketing

| Bucket | Contents | Why |
|---|---|---|
| `lint` | R1 — a `lint-task.ts` rule, an informational report, and the template/SKILL guidance | R1 touches no orchestrator file at all, so it shares nothing with the other branch and can run concurrently. |
| `orchestrator` | R3 → R2 → R5a → R5b → R6 | Every one of these edits the **same fenced JS block** in `orchestrator.md` and the **same fixture**. Serial by necessity. |
| `integration` | the closing Final review | One holistic gate over both branches. |

**Landing order inside `orchestrator/`: R3 → R2 → R5a → R5b → R6.** R3 is the smallest (one agent split,
one schema, one prompt line) and it removes the commit text from the scout prompt that R2 then rewrites, so
landing R3 first avoids a mechanical conflict. R5 and R6 both extend the wave loop / `executeTask` that R2
leaves settled.

**R5 is split into two tasks on purpose.** Its two halves are independent production changes that happen to
touch the same function: one records and renders attempt history, the other changes ladder dispatch and cap
arithmetic. Each also needs its own fixture extension — prompt capture for the history, a config-literal
override for the rung. Bundled, that is too much independent logic to isolate a failure in; split, the
history lands and is verified before the cap arithmetic that hides the append-vs-replace trap is touched.

## Task index

| Ref | Title | Depends on |
|---|---|---|
| `lint/01` | test-runner detection + the final-review regression-net rule | — |
| `lint/02` | informational test-path report | `lint/01` |
| `lint/03` | template + SKILL guidance, then sweep every tree | `lint/01`, `lint/02` |
| `orchestrator/01` | R3 — the commit gets its own agent | — |
| `orchestrator/02` | R2 — the scout transcribes, the script interprets | `orchestrator/01` |
| `orchestrator/03` | R5a — cross-attempt retry history | `orchestrator/02` |
| `orchestrator/04` | R5b — an opt-in vendor-switch last rung | `orchestrator/03` |
| `orchestrator/05` | R6 — budget floor | `orchestrator/04` |
| `integration/01` | Final review | `lint/03`, `orchestrator/05` |

## Eval rubric

Shared bar in `tasks/_context/rubric.md`: `Correctness ×3 · Test coverage ×2 · Interface & readability
×1 · Assumptions & docs ×1`, pass **weighted average > 4.0** on 0–5, `Correctness < 4` is an automatic
veto.

`integration/01` overrides it with the holistic axes: `Integration ×3 · Meets the PLAN goal ×3 ·
Regressions ×3 · Consistency ×2`, pass **> 4.0** on 0–5, `Regressions < 4` veto. The veto dimension is
named as a single word deliberately: the rubric parser captures the token immediately left of the `<`
operator, so a two-word name like "No regressions" would resolve to a dimension that matches no table
row, and `score-task.ts` would report it as missing instead of enforcing the veto.

## Risks

- **R1 enforces presence, not reach.** A Final review task can satisfy the rule with
  `bun test one/narrow/dir` and still miss most of the tree. The informational report is the only
  countermeasure, and it needs a human to read it. Accepted: a weak net that always exists beats a
  strong one that sometimes does not.
- **R1 may fail lint on existing trees.** That is the point — each failure is a real missing net. But
  it will surface at an inconvenient moment for someone mid-plan. A tree already marked `done` must be
  **reported, never retro-fitted**: adding an unticked `## Verification` box to a `done` task makes
  `taskValidity` return `invalid`, and hand-ticking it is forbidden.
- **Fixture drift (R2/R3/R5/R6).** `orchestrator-script.test.ts` extracts the fenced block from
  `orchestrator.md` verbatim. Every change must land in that block, not beside it.
- **R5 raises the worst-case cost per task** by one attempt whenever `lastShotEngine` is on. Off by
  default keeps that opt-in.
- **R6 stops a run short of its Final review** if the floor is set too high. Off by default.
- **The `flightplan-lint.sh` PostToolUse hook runs the plugin-cache copy** of `lint-task.ts`, so R1's
  new rule does not reach the hook until a dispatch release ships. The in-run driver lint
  (`lint-task.ts <file>`) passes a single file, and tree-level checks only fire for a directory
  argument, so the new rule can never fail a task mid-run either.

## Verification

```bash
bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts
bun test packages/dispatch/skills/autopilot/scripts/fleet.test.ts
bun test packages/dispatch/skills/flightplan/scripts/
# R1: lint every existing tree — each failure is a real missing regression net
for t in docs/*/tasks; do bun packages/dispatch/skills/flightplan/scripts/lint-task.ts "$t"; done
```

Full proof needs one real `/autopilot` run over a small tree, checking that the flightlog carries
`role: commit` entries and that `fleet.ts` renders them. A run cannot honestly prove that about itself,
so it is a manual post-merge step — recorded as a Known gap in `tasks/README.md`.

## Open questions

None blocking. One empirical question stands, and it is not a decision: does a real run visibly stall
on wave barriers? If it does, R4 comes back with "commit once at the end".

## Review log

- **2026-08-01, codex (cross-vendor, read-only sandbox)** — confirmed D1, D3, D4, D5, D6. Corrected
  D2: the re-listing incident belongs to the retired line-oriented scout, not the current one.
  Confirmed R1–R3 violate no Workflow constraint. Found two blocking gaps, both folded in: R1 had no
  executable command grammar, and R3's cross-task contamination is a correctness problem that
  index-lock retries cannot fix.
- **2026-08-01, Q** — scoped R3 down to an agent split; kept LLM-written commit messages (evidence:
  `6d0363ed`) and wave-level grouping. D5 reclassified from a defect to a known cost.
- **2026-08-01, Q** — replaced R1's `verify-all.ts` with a lint rule, then made the rule conditional on
  the tree already containing a test command. Mechanical re-execution would report false greens.
- **2026-08-01, Q** — settled every open question. The Workflow chassis stays permanently; the daemon
  executor moved from deferred to rejected. Working the commit-point question demoted R4 to rejected.
- **2026-08-01, Q** — moved the commit agent after the scout guards. Committing first lets a corrupted
  task file reach git before the scout reports it.
- **2026-08-01, Q** — brought R5 and R6 into scope and authored their acceptance criteria. Chose to
  **append** R5's vendor-switch rung rather than replace the Opus rung, so no task loses its Opus
  attempt. Chose a `(budget)` escalation over a clean-stop flag, for consistency with every other
  terminal condition. `CFG.budgetFloor` defaults to off.
