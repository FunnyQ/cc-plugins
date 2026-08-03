# Autopilot: defer-and-requalify + the restore-family ban

> **Status**: approved
> **Owner**: Q
> **Last updated**: 2026-08-03

## Overview

Stop autopilot's non-writer agents from reaching for destructive git, and give the verifier a
sanctioned way to handle red output caused by a sibling task that is still writing the shared
working tree.

## Goals

- Every agent whose prompt lets it choose its own shell commands is told never to run
  `git checkout`, `git restore`, `git reset` or `git clean` — not just the three that write
  source. The boundary is command discretion, not Bash access: every Workflow agent holds Bash,
  so that cannot be the line. Seven prompts hand the agent a decision about what to run; three
  perform one fixed scripted step and receive nothing new.
- A verifier that meets a sibling's half-written tree **postpones** its verdict, waits for the
  tree to go quiet, and re-runs its commands once, strictly. It never wipes the tree, and it
  never waives a non-zero exit.
- A postponement is only ever granted while another task is *observably* mutating the tree, so
  it cannot become a free re-run of a red command.
- The audit trail never records a postponement the orchestrator refused. Both gate checks log
  an ordinary `PASS`/`FAIL` verdict; a granted postponement is visible as the second check's
  row, which is the only mark the orchestrator itself controls.

## Non-goals

- **Making whole-suite gates on parallel tasks correct.** `- [ ] cargo test passes.` on a task
  scheduled into a parallel wave is unsatisfiable-by-luck. The real fix is a `Depends on` edge,
  or moving such gates to the closing review task — both live in the `flightplan` skill and its
  `lint-task.ts`. This plan makes the symptom survivable; it does not fix the authoring defect.
- **A `PreToolUse` hook that blocks destructive git.** Whether plugin hooks fire for Workflow
  subagents is unverified, and a repo-wide git block would fire outside autopilot runs.
- **Waiting for siblings to reach a terminal state** instead of the zero-crossing wait. It
  deadlocks on mutual deferral: A waits for B to terminate, B waits for A, and neither can
  terminate while waiting.
- **Any change to the wave-dispatch model, the commit agents, `heldBack`, or the divergence
  detector.** The defer state never escapes a task, precisely so none of those move.
- Changing what the rubric judge does. Deferral is a binary-gate concern only.

## Context

### What happened

During a live autopilot run in a separate repo, a **verify** agent attempted `git reset --hard`
and a human denied it. Nothing was lost. The run's flightlog shows two dev agents dispatched
into the same wave; the first reported *"Cargo test blocked by unrelated TabLayout config
changes in other task"*. Its verifier then ran `cargo test`, met failures caused by the sibling
still writing `src/config.rs`, and reached for a clean tree.

That same verifier went on to report `PASS` over two still-failing tests, attributing them to
the sibling on its own initiative. **That is a false positive already in the wild**, and it is
the reason the fix below never lets a verifier waive a non-zero exit.

### Why it happened

`NO_COMMIT_RULE` already carries a paragraph banning the restore family, written precisely
because parallel tasks share one working tree. It is injected into `devPrompt`,
`devExternalPrompt` and `fixPrompt` — the three prompts whose agents write source. The ban was
scoped by **role**, and universal Bash access is what makes that proxy invalid: the verifier,
the judge, the review lenses and the commit agents all hold Bash too, so "writer" never bounded
who *could* run the command.

Bash access is not the replacement boundary either, since every Workflow agent has it — three
prompts are excluded on purpose. The boundary is **command discretion**: whether the prompt
hands the agent a decision about what to run.

### Why prompt text is the only lever

Workflow `agent()` accepts no tool allowlist, and agent-frontmatter tool lists do not constrain
Workflow subagents. A PATH `git` wrapper is bypassed by an absolute path. Comparing the tree
before and after only *detects* damage, and `reset --hard` has already destroyed the
uncommitted evidence it would need. `isolation: 'worktree'` blinds the verifier to the very
uncommitted edits it must verify. So the ban is defense-in-depth, and removing the *motive* —
what this plan's second half does — is the part that actually changes outcomes.

### Design provenance

The design was settled over two independent cross-vendor review rounds. Round 1 rejected an
earlier version that let the verifier waive sibling-caused failures, and found that the commit
agents had been wrongly excluded from the ban. Round 2 found that the writer count missed the
post-dev task-file writers, and that a deferral was legal even when no sibling was actually
writing — the guard now recorded as requirement 7. One round-2 claim was checked and rejected:
the rubric judge is not a tree writer, because `score-task.ts` only reads the task file and
appends to the self-gitignored flightlog.

## Requirements

### MVP

1. **`NO_RESTORE_RULE` is its own constant** — extracted from `NO_COMMIT_RULE`, which then
   composes it, so the three existing writer prompts render byte-identical text.
   - Acceptance: the rendered text of `devPrompt`, `devExternalPrompt` and `fixPrompt` is
     unchanged; the ban's marker sentence appears in seven prompts, not three.
2. **Every prompt that lets its agent choose commands carries the ban** — adding the verifier,
   the judge, the review lenses and the commit instructions to the three writers.
   - Acceptance: each of those four builders includes `NO_RESTORE_RULE`; the mark-done,
     mark-blocked and wave-scout prompts, which each run one fixed command, are unchanged.
3. **The external review lens propagates the ban to the CLI it drives** — a driver's own prompt
   does not constrain a `--dangerous` delegate.
   - Acceptance: the external review branch instructs the driver to write the ban into the
     instruction file it hands the external CLI.
4. **A wave-scoped tree watch reports when the tree is quiet** — a live writer count with a
   next-zero-crossing wait, not a one-shot barrier, because a task that fails its gate retries
   dev and writes again.
   - Acceptance: a deferred task's requalify is not issued while any other task is inside a
     counted mutation window; a wave in which every task defers at once resolves immediately
     rather than hanging.
5. **Every window that mutates the tracked tree is counted** — the dev step and the final-review
   round, the mark-done transition, and both park paths, including the one in the guarded
   wrapper's catch, which sits outside the task pipeline.
   - Acceptance: a sibling held inside its catch-path park delays a requalify.
6. **A verifier may defer instead of failing** — it returns `deferred`, waits for quiet, and
   re-runs its commands once in a requalify mode whose verdict is final.
   - Acceptance: a defer consumes no attempt; a failing requalify falls through to the normal
     dev retry; the defer state never escapes the task pipeline.
7. **Four code-level guards bound the defer** — it is refused unless the wave dispatched more
   than one task, the summary carries the `SUSPECTED SIBLING INTERFERENCE` marker, the gate
   verdict is a failure, and **another task is inside a counted mutation window right now**.
   The requalify call ignores `deferred` outright.
   - Acceptance: each guard downgrades a deferral to a plain failure, and spawns no second
     verify agent.
8. **No gate message announces a postponement.** The agent writes its flightlog entry before it
   returns, so the guards have not run yet — a message claiming a postponement would survive one
   the guards go on to refuse, and the trail would show a state the pipeline never granted.
   - Acceptance: both modes lead with `PASS` or `FAIL`; a refused postponement leaves an
     ordinary failure row and nothing after it.
9. **The requalify agent label is a deliberate role extension** — the label parser matches a
   closed set, so a new pseudo-role would parse as unknown, lose its ref and attempt, and fall
   out of both the role ordering and the gate-outcome reader.
   - Acceptance: the requalify label parses to its own role with the right ref and attempt, is
     ranked between the first check and scoring, and has its verdict read.
10. **The design notes record both failure modes** — why the ban is scoped by tool access, and
    why the verifier gets a defer rather than a waiver or a strict fail.
    - Acceptance: two entries in the orchestrator's design-notes section, naming the run and
      the denied command.

### Later

- **Wave-quiescent re-verification as a pipeline stage** — re-running verification for a whole
  wave after every writer settles. It removes the residual race where a sibling starts a retry
  just after a zero-crossing releases a waiter, but it is a redesign of the wave loop rather
  than a change to one task's gate.
- **Narrowing whole-suite verification gates at authoring time** — a `flightplan` / `lint-task`
  concern, see Non-goals.

## Tech decisions

- **Stack**: Bun + TypeScript for the scripts and tests; the orchestrator itself is plain
  JavaScript inside a fenced block in a markdown reference file.
- **Storage**: none. The tree watch is in-memory, per wave.
- **Deployment**: the `dispatch` plugin ships from this repo to two marketplaces.
- **Conventions**: see `tasks/_context/shared.md`.

## Architecture

The orchestrator script is the whole surface for the mechanism. The dashboard is a separate,
downstream consumer of the flightlog the mechanism writes.

```
orchestrator.md  (fenced JS = the Workflow script)
  NO_RESTORE_RULE ─────────┬──> devPrompt / devExternalPrompt / fixPrompt   (via NO_COMMIT_RULE)
                           └──> verifyPrompt / judgePrompt / reviewPrompt / commitInstructions

  wave loop
    makeTreeWatch()  ── per wave, created before parallel() ──┐
    parallel(fresh.map(item => runTaskGuarded(item, watch)))  │
                                                              │
    executeTask(item, watch)                                  │
      withWriter(watch, dev | runFinalReview)  ───────────────┤  counted mutation windows
      verify ──> deferred? ──> await watch.quiet() ──> requalify (strict, final)
      withWriter(watch, markDone)              ───────────────┤
      withWriter(watch, parkBlocked)           ───────────────┤
    runTaskGuarded's catch                                    │
      withWriter(watch, parkBlocked)           ───────────────┘

flightlog run.jsonl              ──>  fleet.ts parseAgentLabel + gateOutcome
  verify:<ref>#<n>    "FAIL — …"        role verify,    outcome failed
  requalify:<ref>#<n> "PASS — …"        role requalify, outcome passed   ← new role, existing outcomes
```

The second row's *existence* is what records that the postponement was granted. Nothing needs a
third outcome value, and `dashboard/dist/` is untouched.

## Bucketing

- **Strategy**: single bucket.
- **Why**: one mechanism, one file for most of it. A layered split would create buckets that
  cannot advance in parallel anyway, since four of the six tasks edit the same file.

### Buckets

- **`work/`** — everything. Starts at the ban, ends at the closing review.

## Task index

| Bucket | NN | Title | Status | Pass line | Depends on |
|---|---|---|---|---|---|
| work | 01 | restore-family-ban | todo | > 4.0 | — |
| work | 02 | wave-tree-watch | todo | > 4.0 | work/01 |
| work | 03 | defer-and-requalify | todo | > 4.0 | work/02 |
| work | 04 | dashboard-defer-state | todo | > 4.0 | work/03 |
| work | 05 | design-notes | todo | > 4.0 | work/03 |
| work | 06 | final review 🏁 | todo | > 4.0 | work/04, work/05 |

Only `04` and `05` may share a wave. The chain `01 → 02 → 03` is sequential because all three
edit the same fenced script, and `01`'s injection into the verifier prompt lands in the exact
region `03` rewrites.

## Open questions

None. Both review rounds closed; the zero-crossing-versus-terminal-state question was decided
in favour of zero-crossing, and is recorded under Non-goals.

## Known gaps

- The residual race named under Requirements → Later: a sibling can begin a dev retry the
  instant after a zero-crossing releases a waiter, so a requalify can still meet a dirty tree.
  It then fails strictly, which is the pre-existing behaviour — never worse.
- A deferral proves that *some* other task was writing, never that that task caused the
  failure. The strict requalify is what makes a wrong attribution cheap.

## References

- The originating incident's flightlog, in the affected repo at
  `docs/tab-layout-selector/.flightlog/run.jsonl`.
