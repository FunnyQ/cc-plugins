# WORK-06: Final review

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/orchestrator-anatomy.md`
>
> **Depends on**: work/04, work/05
> **Status**: blocked
> **Final review**: true

## Goal

Confirm the whole deliverable composes: every prompt that gives its agent discretion over what
commands to run tells it never to use the destructive git restore family, and a verifier that
meets a sibling task's half-written working tree postpones its verdict, waits for the tree to go
quiet, and re-runs its commands once strictly — never wiping the tree, and never waiving a
non-zero exit.

The boundary is command discretion, not Bash access: every Workflow agent holds Bash, so that
cannot be the line. Prompts that perform one fixed scripted step — the two task-status
transitions and the wave scout — are excluded by design, and finding them without the ban is
not a defect.

## Files to create / modify

This is a review. It reads everything the plan touched and writes only where it finds a real
defect. The surface it must read, and may fix:

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify, only on a finding) —
  the fenced Workflow script: the git-rule constants, every prompt builder, the per-task
  pipeline, the wave loop, and the design-notes prose below the fence.
- `packages/dispatch/skills/autopilot/scripts/fleet.ts` (modify, only on a finding) — flightlog
  entries to dashboard rows: the gate-outcome derivation and the agent-label parser.
- `packages/dispatch/skills/autopilot/dashboard/dist/modules/fleet.js` and
  `packages/dispatch/skills/autopilot/dashboard/dist/style.css` (read, and modify only if this
  work broke them) — row rendering and the row-state colour tokens. Nothing in this plan is
  meant to change either file; a diff here is itself a finding.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` and
  `packages/dispatch/skills/autopilot/scripts/fleet.test.ts` (modify, only on a finding) — the
  two suites this work extends. Inspect `fleet.test.ts` alongside `fleet.ts`: a missing label or
  outcome assertion there is exactly the kind of gap that lets a half-done role extension pass.
- `packages/dispatch/skills/autopilot/dashboard/dist/modules/fleet.test.js` and its siblings
  under that directory (read) — untouched by this work, so a diff here is itself a finding.

## Implementation notes

Score integration, not individual tasks. Each piece of work already passed its own binary gate
and rubric; re-litigating those is out of scope. What no earlier gate could see is whether the
pieces still agree with each other now that they are all in the tree.

Work through the seven checks below in order. For each, state what you read, what you
concluded, and — where the check has a command — what the command printed.

### 1. Integration across the two halves

The restore-family ban and the deferral mechanism edit the same fenced script, and the later
work rewrote the verifier prompt that the earlier work had just injected the ban into. So the
ban is exactly the kind of thing a subsequent rewrite drops silently.

Confirm the restore-family ban still reaches every prompt builder intended to carry it: the
Claude dev prompt, the external-engine dev driver, the final-review fixer, the verifier, the
rubric judge, the review lenses, and the inline commit instructions. Seven builders. The first
three receive it through the composed commit rule; the last four receive it directly.

Two builders are intentionally excluded and must stay excluded: the mark-done prompt and the
park prompt, both of which run one scripted step against the task file and issue no git. The
wave scout is likewise excluded — it runs a single readiness command and returns stdout
verbatim.

Also confirm the external review lens still instructs its driver to write the ban into the
instruction file it hands the external CLI. A driver's own prompt does not constrain a delegate
running with approvals bypassed; only the text handed to that CLI does.

### 2. The verifier prompt is coherent as one document

Read the verifier prompt end to end, in the order a model receives it, and as the cheapest
model in the run — because that is who receives it. It now carries five things at once: the
restore-family ban, the warning that tasks share one working tree, the rule that any non-zero
exit is a failure, the deferral contract, and a mode switch between the first check and the
follow-up check.

The failure to look for is a clause that reads as permission to waive a failing command. This
is not hypothetical: the incident that motivated the whole plan ended with a verifier reporting
a pass over two still-failing tests, having attributed them to a sibling on its own initiative.
Any sentence that a hurried reader could take as "you may decide this red result does not
count" is a defect, even if a careful reader would not.

Confirm the two modes do not contradict each other, and that the follow-up mode is unambiguous
that its verdict is final.

### 3. The guards are in code, not only in prose

Every condition that refuses a postponement must be enforced by the script, not merely
requested in the prompt. Read the pipeline and confirm each refusal is a branch the script
takes, and that a refused postponement falls through to the ordinary failure path **without
spawning a second verify agent**.

The conditions to find enforced: a wave that dispatched only one task; a summary missing the
agreed marker phrase; a gate verdict that is not a failure; and no other task currently inside
a counted mutation window. Also confirm the follow-up check ignores a repeated postponement
request outright.

A guard that exists only as a sentence in the prompt is the defect. Cheap models sit on the
gate roles, so an invariant that matters has to be enforced where the model cannot argue with
it.

### 4. Writer accounting has no leak

Every counted mutation window must release its count on **both** its success and its failure
paths. A leaked count means the writer total never returns to zero, and a later postponement
waits forever — a hang, not an error.

**The complete set to inspect**, so this review does not depend on reading another task file:

| Must be counted | Note |
|---|---|
| Each of the three dev-agent branches in the attempt ladder | the external-engine rung, the configured external engine, and the Claude dev agent |
| The final-review round | wrapped as one window around the whole awaited call, which legitimately encloses its read-only lenses |
| The mark-done transition | it rewrites the task file's status and gate boxes |
| Every park path | five call sites, wrapped inside the park helper itself — including the one in the guarded wrapper's catch, which sits outside the per-task pipeline, so anything scoped inside the pipeline misses it |

| Must **not** be counted | Note |
|---|---|
| The rubric judge | its scorer only reads the task file and appends to the self-gitignored flightlog; counting it would delay the quiet signal for nothing |
| The verifier | it must not write at all |
| Each individual review-lens call | no wrapper of its own; being enclosed by the final-review window is expected |

Confirm each release is unconditional — reached through a `finally`, so a throwing writer still
decrements.

### 5. No regression in the untouched machinery

The deferral state was designed never to escape the per-task pipeline, precisely so the
surrounding machinery would not move. Confirm it did not:

- Wave reconciliation still pairs results to tasks by index, so a null result lands on its own
  task instead of disappearing.
- The held-back path list still collects a parked task's declared paths and keeps them out of
  the commit agents' reach.
- The commit agents still commit each wave and are still the only agents that commit.
- The divergence detector still compares completed refs against what the scout finds unfinished
  on disk, as a set intersection.

If any of these changed shape, that is a finding regardless of whether tests still pass.

### 6. The trail records the orchestrator's decision, not the agent's request

The audit contract is deliberately minimal, and the review's job is to confirm it was kept
rather than to ask for more:

- **Neither gate check announces a postponement.** Both lead with an ordinary `PASS` or `FAIL`.
  A verifier requesting a postponement is returning a failure, so its row stays failed even when
  the request is granted. Confirm no third verdict word was introduced anywhere in the trail.
  The reason is load-bearing: an agent writes its flightlog entry before it returns, so the
  guards have not run yet — a message claiming a postponement would survive one the guards go on
  to refuse, and the trail would assert a state the pipeline never granted.
- **The second row's existence is the whole signal.** A granted postponement reads as a failed
  first check followed by a follow-up check carrying its own binary verdict; a refused one reads
  as a failed check with nothing after it. Confirm both shapes are producible and that neither
  needs a new outcome value.
- **The follow-up check's agent label parses to a known role**, with the right task ref and
  attempt number, is ranked between the first check and scoring, and has its verdict read by the
  outcome derivation. The label parser matches a closed set of roles and the outcome derivation
  early-returns for roles it does not know, so a half-done extension leaves those rows silently
  uncoloured rather than visibly wrong.

Do **not** treat the absence of a postponement-specific row state, colour token or
screen-reader branch as a finding. There is no third verdict word to key one off, so such a
state would be permanently unreachable, and requiring it would reopen the audit hole this
contract closes.

### 7. Cross-file consistency

Search the touched files for prose that still describes the gate as two-state. Comments inside
the fenced script, the design-notes prose below it, and any test-file header that documents the
gate contract are all in scope. A stale note that contradicts the shipped behaviour is a real
finding — this codebase's comments are load-bearing documentation, not decoration.

### Applying fixes

Fix what you find, forward, by editing the file. Do not commit — the run's commit agents own
that. Never run `git checkout`, `git restore`, `git reset` or `git clean`; other tasks' work
may be uncommitted in this tree.

If a finding is real but too large to fix safely here, say so explicitly in your summary rather
than leaving it silently unaddressed.

## Acceptance criteria

- [ ] The restore-family ban is present in all seven intended prompt builders, absent from the
      two intentionally-excluded ones and from the wave scout, and the three prompts that
      already carried it before this plan render unchanged text.
- [ ] The external review lens instructs its driver to write the ban into the instruction file
      handed to the external CLI.
- [ ] Both rendered verifier-prompt modes are captured from the deterministic fixture and each
      is checked mechanically, not by impression. **Required in both**: a clause mapping any
      non-zero exit to `passed=false`, and the restore-family ban. **Required in the normal mode
      only**: the literal evidence marker string, and a statement that an unsupported request
      counts as a plain failure. **Required in the follow-up mode only**: that the sibling
      explanation no longer applies and that a postponement request is ignored on that run.
      **Forbidden in both**: any conditional attached to the non-zero-exit rule — search the
      captured text for `unless`, `except`, `may still pass`, `can be ignored` and `disregard`
      near that clause, and treat any hit as a finding to quote rather than to judge.
- [ ] Every condition that refuses a postponement is enforced by a branch in the script, and a
      refused postponement spawns no second verify agent.
- [ ] Every counted mutation window releases its count on both success and failure paths,
      including the park inside the guarded wrapper's catch; the rubric judge is not counted.
- [ ] Wave reconciliation, the held-back path list, the commit agents and the divergence
      detector are unchanged, established two ways rather than by assertion: every pre-existing
      test covering them passes untouched — none was edited, skipped or reworded to accommodate
      this work — and `git diff` over their source regions shows only the threading of the new
      per-wave object, with no change to any condition or branch.
- [ ] Both gate rows carry their own binary outcome downstream — the first check's failure
      renders as a failure, and the follow-up check's label parses to a known role, ranks
      between that check and scoring, and has its own verdict read. The presence of the second
      row is the only postponement signal; no third outcome value exists.
- [ ] No comment, design note, or test-file header still describes the gate as two-state.

## Verification

- [ ] `bun test packages/dispatch/skills/autopilot/scripts/` passes; report the pass/fail counts
      against the recorded baseline of 198 pass / 0 fail across 10 files, and account for the
      difference.
- [ ] `bun test packages/dispatch/skills/autopilot/dashboard/dist/modules/` passes; report its
      pass/fail counts.
- [ ] Read the verifier prompt builder in
      `packages/dispatch/skills/autopilot/references/orchestrator.md` from its first line to its
      last and quote the clause that states a non-zero exit is a failure.
- [ ] Confirm the restore-family ban reaches all seven intended builders **as rendered text**,
      not as source occurrences. Grepping the script cannot show this: the ban is deliberately
      stored once in a single constant, so every builder holds an interpolation or a
      concatenation reference rather than the words themselves. Use the deterministic fixture,
      which already captures every prompt string the script passes to `agent()`, and assert that
      a distinctive sentence from the ban appears in **eight rendered captures** — the seven
      builders, with the verifier counted twice because its two modes render separately: dev,
      external-dev, fixer, verify, requalify, judge, review and commit-agent. Report any capture
      it does not reach.
- [ ] If this review edited any file, run
      `git status --short -- <each path you edited> docs/autopilot-defer-requalify/tasks/work/06-final-review.md`
      and confirm those paths are dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Integration < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Integration | ×3 | the halves conflict — the ban was dropped from a prompt a later edit rewrote, or the deferral state escapes the per-task pipeline | it composes, but a seam was confirmed by reading alone where a test could have proved it | every seam holds and the deterministic fixture proves the ones that can be proved; the ban reaches each intended prompt and a postponement stays inside its task |
| Meets the plan goal | ×2 | a command-discretion prompt is missing the ban, some instruction still authorises destructive git, or a postponement can waive a non-zero exit | the mechanism is present but at least one refusal condition is prose-only | every command-discretion prompt carries the ban with nothing contradicting it, and a postponement is bounded by conditions the script enforces |
| Consistency | ×1 | a document contradicts the shipped contract — for example a comment or note implying the trail carries a third verdict word | mostly consistent; one document lags the shipped behaviour | every document draws the same line: a postponement is an internal request the script may refuse, while the persisted trail and the dashboard stay strictly binary, with the follow-up row's presence as the only outward signal |
| No regressions | ×1 | a suite is red, or untouched machinery changed shape | suites green, but the untouched machinery was assumed rather than checked | both suites green at or above baseline, and reconciliation, held-back paths, commit agents and divergence detection verified unchanged |

## Out of scope

- **Re-scoring individual pieces of work.** Each already passed its own binary gate and rubric.
  This gate scores whether they compose, not whether each was well built.
- **Narrowing whole-suite verification gates at authoring time.** A task asserting that a whole
  test suite passes is unsatisfiable-by-luck when it runs in a parallel wave, but the fix lives
  in the planning skill and its task linter. Deferred. Reason: this plan makes the symptom
  survivable, it does not change how gates are authored.
- **A tool-level block on destructive git.** Deferred. Reason: whether plugin hooks fire for
  Workflow subagents is unverified, and a repo-wide block would fire outside autopilot runs.
