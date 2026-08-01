# ORCHESTRATOR-01: give the commit step its own agent

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/orchestrator-contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: none
> **Status**: todo

## Goal

The inter-wave commit becomes its own `agent()` call with its own result schema, running after every
scout guard, so a blocked commit is reportable — and both commit workers are instructed to emit matched
flightlog entries under `--role commit`.

Scope note on the audit trail: what this task delivers and proves is the **emission instruction plus the
renderer's ability to display such an entry**. That real commit workers then write those records during a
live run is not provable from inside this tree — it needs an actual execution run — and is recorded as a
Known gap rather than claimed here.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — inside the fenced
  ```` ```javascript ```` block: add `COMMIT_SCHEMA`, extract the commit out of the scout prompt into
  its own agent call, move it after the guards, turn `COMMIT_INSTRUCTIONS` into a label-taking builder with
  start/end flightlog calls, and give the post-loop commit the same schema and escalation.
- The same file, **outside** the fenced block (modify) — the prose this change makes stale. The wave-loop
  diagram in the "Context" section still shows the commit riding the scout as a preamble, the terminal-
  conditions gotcha does not know a commit can now escalate, and the commit gotcha describes a step that
  no longer sits where it says. Update each to describe what now ships. Prose that contradicts the script
  is worse than no prose: the next author trusts it.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify) — a commit branch in
  the stub `agent`, a `commit` scenario field, and the ordering / escalation / no-commit cases.
- `packages/dispatch/skills/autopilot/scripts/fleet.test.ts` (modify) — one case proving a flightlog entry
  carrying `role: commit` renders.

## Implementation notes

### The two defects this closes

**A blocked commit is unreportable.** Today the inter-wave commit is a *prefix string* glued onto the
scout's prompt:

```js
const commitPreamble = (wave > 1 && CFG.commitBetweenWaves && escalations.length === 0)
  ? `First, commit all changes from the previous wave.\n${COMMIT_INSTRUCTIONS}\n\nThen: `
  : ``

const scout = await agent(
  commitPreamble
  + `First, announce yourself: bun ${S}/flightlog.ts log ...`
  ...,
  { label: `scout-wave-${wave}`, phase: 'Execute', model: MODEL.verify, schema: SCOUT_SCHEMA })
```

The result comes back under `SCOUT_SCHEMA`, which describes a tree and has no commit-outcome field, and
every line of downstream logic reads tree fields only. So a rejecting pre-commit hook, a merge conflict,
or an index lock has nowhere to land. `COMMIT_INSTRUCTIONS` already tells the agent to "stop committing,
and say so explicitly in your summary" — but under a tree schema there is no summary anybody reads.

**Commits never enter the audit trail.** No commit path calls `flightlog.ts`. The dashboard side is
already finished: `fleet.ts` carries `commit` in its role union, parses the `commit-post-loop` label, and
falls back to an entry's own `role` field when the label has no task ref. Only *emission* is missing, so
this is a one-line prompt change, not a `fleet.ts` change.

### Ordering is the correctness fix, not a tidy-up

The commit currently runs **before** the scout. So a wave that corrupted a task file gets that corruption
committed — and described by the commit agent, from the diff, as an intentional change — *before* the
scout reports a non-empty `errors` array or `invalid > 0` and aborts the run. Committing into a tree that
the very next guard is about to declare untrustworthy is exactly what the `escalations.length === 0` guard
exists to prevent; the guard simply cannot see a defect the scout has not found yet.

Move the commit call to sit **after all seven scout guards** — the null/`error` check, the `errors`
parse-failure check, the counts-sum check, the `invalid > 0` check, the `done === total` completion check,
the `fresh` filter, and the empty-`fresh` stall check — and immediately **before** the `parallel()`
dispatch, next to the `log(\`Wave ${wave}: ...\`)` line.

Running after the guards also removes a redundant commit on the `done === total` path: that branch breaks
out of the loop, and the post-loop commit already covers the last wave's changes. Today it commits twice.

One consequence to keep in mind and not to "fix": when the loop breaks at a guard, the previous wave's
changes get no inter-wave commit, and the post-loop commit is skipped too because an escalation now
exists. That dirty tree is a deliberate, already-documented cost of the escalation-free guard — rejected
and in-flight edits share one working tree, so not committing is the safe behaviour. Leave it alone.

### The schema and the call

```js
// The commit is an infrastructure boundary like the status transitions: it can
// silently not happen. A rejecting hook, a conflict, or an index lock needs
// somewhere to land, so the step reports a verdict instead of a narrative.
const COMMIT_SCHEMA = {
  type: 'object',
  properties: {
    committed: { type: 'boolean' },                        // at least one commit was created
    shas:      { type: 'array', items: { type: 'string' } },// the commits actually created
    failed:    { type: 'boolean' },                        // a git command failed
    reason:    { type: 'string' },                         // the git error, or why nothing was committed
  },
  required: ['committed', 'shas', 'failed', 'reason'],
}
```

Keep the gating condition byte-identical — `wave > 1 && CFG.commitBetweenWaves && escalations.length === 0`
— and only change where it is evaluated and what it produces:

```js
if (wave > 1 && CFG.commitBetweenWaves && escalations.length === 0) {
  const committed = await agent(
    `Commit all changes from the previous wave.\n${commitInstructions(`commit-wave-${wave}`)}`,
    { label: `commit-wave-${wave}`, phase: 'Execute', model: MODEL.commit, schema: COMMIT_SCHEMA })
  // A failed commit is not a reason to abandon ready tasks: the guard above
  // already stops every later commit once this escalation exists. Report and
  // carry on.
  if (!committed || committed.failed) {
    const reason = committed
      ? `the wave ${wave - 1} commit failed: ${committed.reason || 'no reason reported'}`
      : `the wave ${wave - 1} commit agent returned no structured result, so whether anything was committed is unknown`
    log(reason)
    escalations.push({ task: '(commit)', attempt: 0, infrastructure: true, parked: false, reason })
  }
}
```

`MODEL.commit` is already `'haiku'` in the `MODEL` map and the post-loop commit already uses it; the
inter-wave commit is the one that has been riding the scout on `MODEL.verify`. Use `MODEL.commit` for
both after this change.

**Do not `break` on a failed commit.** The escalation itself is what stops later commits, via the
existing guard. Breaking would abandon tasks that are ready and healthy because of a git problem, and
this change is deliberately scoped not to re-litigate that guard.

A null result and `failed: true` are both escalations, but the reasons must differ: a null means nothing
is known about whether a commit happened, which is strictly worse than a reported failure, and the text
should say so rather than inventing a git error.

### The flightlog line

The commit worker follows the **same start/end lifecycle every other worker prompt uses**: an announce
call before the work, a completion call after it, with the *identical* `--agent` label in both. A lone
`--phase end` entry would be an unmatched terminal event, and the trail renderer pairs entries by label.

**`COMMIT_INSTRUCTIONS` must therefore become a builder, not a constant.** Every other worker prompt tells
the agent to invent a label and reuse it (`--agent "<your label>"`), which is acceptable there because only
that agent's own two entries need to agree. It is *not* acceptable here: two different call sites share this
one string, and the audit trail is only useful if an entry's label matches the `agent()` label the run
actually dispatched (`commit-wave-<n>` or `commit-post-loop`). Leaving `<your label>` in place lets the
agent fabricate any label it likes, and the trail then pairs entries under a name that appears nowhere in
the run.

So take the label as a parameter and interpolate it, rather than asking for a substitution:

```js
// A builder, not a constant: the two call sites dispatch under different agent()
// labels, and a flightlog entry is only traceable if its --agent matches the
// label the run actually used. Interpolating it removes the agent's chance to
// invent one.
const commitInstructions = (agentLabel) =>
  'Commit the current working-tree changes as one or more ATOMIC commits using plain git over Bash. '
  + ...
```

Call sites pass their own label, which is the same literal used in `opts.label`:

```js
commitInstructions(`commit-wave-${wave}`)   // inter-wave
commitInstructions('commit-post-loop')      // post-loop
```

Add two steps to the built string. First an announce step **before** the existing `git status --porcelain`
step, renumbering the rest:

```
`1. First, announce yourself: bun ${S}/flightlog.ts log ${CFG.logFile} --task commit --role commit --agent "${agentLabel}" --phase start\n`
```

Then the completion step, after the existing `git log --oneline -n 5` confirmation and before the failure
rule, so the entry is written from confirmed shas:

```
+ `  bun ${S}/flightlog.ts log ${CFG.logFile} --task commit --role commit --agent "${agentLabel}" --phase end --message "<shas + one line per commit>"\n`
```

Renumber the remaining steps, including the failure rule, accordingly. Both commands must carry the
interpolated label literally — no `<your label>` placeholder survives in either.

The end call must also run on the **failure** path. A commit that was blocked still needs its start event
closed, with a message naming the git error — otherwise the one case the audit trail exists to capture is
the one case it silently drops. Say so explicitly in the failure rule.

The orchestrator prose says the commit convention lives in "that one constant". Update it to name the
builder, or it points at something that no longer exists.

`--role commit` is the field `fleet.ts` reads. Keep the constant a single `+`-concatenated string in the
same style as the rest of the file — it is inlined because a Workflow agent has no `Agent` tool and cannot
invoke a commit skill.

### The post-loop commit

It already runs on `MODEL.commit` under the label `commit-post-loop`, but it has the identical blind spot:
no schema, so its failure is invisible. Give it `COMMIT_SCHEMA` and the same
`!result || result.failed` → `(commit)` escalation. Its guard
(`CFG.commitBetweenWaves && escalations.length === 0`) stays as-is. An escalation pushed here still
reaches the caller, because it lands in the returned `escalations` array.

### Scrub the scout

After the extraction, `SCOUT_SCHEMA` and the scout prompt must contain **zero** commit text. The scout
prompt returns to describing the tree and nothing else, and the `commitPreamble` binding disappears
entirely rather than being left assigned to `''`.

### Fixture work

Add a commit branch to the stub `agent`, keyed on the label prefix rather than a task ref (a commit has
no ref):

```js
if (label.startsWith("commit-")) {
  return commits.length > 0 ? commits.shift() : { committed: true, shas: ["abc1234"], failed: false, reason: "" }
}
```

Back it with a `commit?: ({ committed, shas, failed, reason } | null)[]` scenario field consumed in call
order, mirroring how `scouts` already works. Then add these cases:

- A wave whose commit returns `failed: true` produces one escalation with `task: '(commit)'`,
  `infrastructure: true`, `parked: false`, and a reason carrying the reported git error — and the run
  still completes its ready tasks rather than stopping.
- A wave whose commit returns `null` also escalates, with a reason that says the outcome is unknown.
- **Ordering**: in a two-wave scenario, the index of the `commit-wave-2` label in `labels` is greater
  than the index of `scout-wave-2` and less than the index of the first `dev:` label of that wave.
- A wave that aborts on a guard (a non-empty `errors` array, or `invalid > 0`) emits **no** label starting
  with `commit-`.
- The wave where `done === total` emits no `commit-wave-` label; only `commit-post-loop` runs.
- The existing `accountsForEveryTask` invariant still holds in every scenario — a `(commit)` escalation is
  synthetic and must not disturb the per-task `completed` XOR `escalations` accounting.

In `fleet.test.ts`, add one case that feeds a synthesized flightlog line carrying `role: commit` (and the
`commit-post-loop` agent label) through the existing parse path and asserts it renders with that role.
`fleet.ts` itself needs no change — if it does, the change is out of scope and should be reported instead.

### Out of scope for this task

- Any change to `fleet.ts` source. It already handles the role; only emission was missing.
- Changing what gets committed, how the wave's files are grouped, or who writes the commit message. An
  LLM keeps writing the message from the real diff, and grouping stays wave-level and atomic.
- Per-task commits. They need a serialization slot plus an in-flight file-overlap check, because
  `git add <path>` stages whatever that path holds at that moment and same-wave pipelines share one
  working tree — a large amount of machinery for worse grouping. Rejected.
- Relaxing or removing the `escalations.length === 0` guard.
- Anything to do with the scout's result *shape*. This task only removes commit text from its prompt.

## Acceptance criteria

- [ ] `COMMIT_SCHEMA` exists inside the fenced ```` ```javascript ```` block with all four fields
      (`committed`, `shas`, `failed`, `reason`) listed in `required`.
- [ ] The inter-wave commit is its own `agent()` call labelled `commit-wave-<n>`, running on
      `MODEL.commit` with `schema: COMMIT_SCHEMA`.
- [ ] That call sits after every scout guard and immediately before the `parallel()` dispatch; no commit
      text remains anywhere in the scout prompt, and the `commitPreamble` binding is gone.
- [ ] The gating condition is still exactly `wave > 1 && CFG.commitBetweenWaves && escalations.length === 0`.
- [ ] `SCOUT_SCHEMA` is byte-for-byte unchanged by this task.
- [ ] A commit result with `failed: true` pushes one escalation with `task: '(commit)'`, `attempt: 0`,
      `infrastructure: true`, `parked: false`, and a reason carrying the reported git error.
- [ ] A null commit result pushes an escalation whose reason states the outcome is unknown, distinct from
      the reported-failure wording.
- [ ] Neither commit escalation breaks the wave loop; ready tasks in that wave still run.
- [ ] The commit instructions are built by a function taking the agent label, not a bare constant, and
      each call site passes the same literal it uses as its `agent()` label.
- [ ] The built string carries a `--phase start` flightlog call with `--role commit` **before** its
      `git status --porcelain` step, and a matching `--phase end` call after the
      `git log --oneline -n 5` confirmation and before the failure rule, with the remaining steps
      renumbered.
- [ ] Both flightlog commands carry the interpolated label; no `<your label>` placeholder remains in
      either, so an agent cannot pair its entries under a fabricated name.
- [ ] The post-loop commit uses `COMMIT_SCHEMA` and the same `(commit)` escalation on failure or a null
      result, with its own guard unchanged.
- [ ] The `done === total` wave produces no inter-wave commit, so the last wave is committed exactly once.
- [ ] `fleet.ts` source is unmodified.

- [ ] The wave-loop diagram and the affected gotchas in `orchestrator.md` describe the commit's new
      position, its schema, and the fact that a commit can now escalate — no stale claim about the
      commit survives outside the fenced block.

- [ ] The commit instructions carry BOTH a `--phase start` announce call and a `--phase end`
      completion call, with the identical `--agent` label in each, matching the lifecycle every other
      worker prompt follows.
- [ ] The end call is also required on the failure path, so a blocked commit closes its start event
      instead of leaving an unmatched entry.

## Verification

- [ ] Every **executable-script** change lands inside the fenced ```` ```javascript ```` block of
      `orchestrator.md` — the fixture extracts that block verbatim by string search, so script logic
      written in the surrounding prose is invisible to both the runtime and the test.
- [ ] The prose corrections listed under "Files to create / modify" are made **outside** that block, and
      no longer contradict the shipped script. These two checks are complementary, not in tension: script
      logic goes inside the fence, descriptions of it go outside.
- [ ] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` green.
- [ ] `bun test packages/dispatch/skills/autopilot/scripts/fleet.test.ts` green.
- [ ] `bun test packages/dispatch/skills/autopilot/scripts/` green — no regression in the sibling suites.
- [ ] A fixture assertion proves the label order within one wave: `commit-wave-2` appears after
      `scout-wave-2` and before that wave's first `dev:` label.
- [ ] A fixture assertion proves a guard-aborted wave emits no label starting with `commit-`.
- [ ] `grep -c "commit" packages/dispatch/skills/autopilot/scripts/fleet.ts` is unchanged from before the
      task, confirming `fleet.ts` was not edited.
- [ ] `git diff --stat packages/dispatch/skills/autopilot/scripts/fleet.ts` is empty.

## Eval rubric

Anchors and scoring notes are in `../_context/rubric.md`; the bar below is the one that gates this task.

> Score each dimension 0–5. Pass needs a weighted average **> 4.0** on the 0–5 scale.
> `Correctness < 4` is an automatic veto regardless of the average.

| Dimension | Weight | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| Correctness | ×3 | The commit still runs before a guard, or a failed commit breaks the loop, or `SCOUT_SCHEMA` was touched. | The split and schema are right but the placement or an escalation shape is off in one case. | Placement after all guards, both escalation shapes, the preserved guard condition, and the untouched scout schema all hold. |
| Test coverage | ×2 | No fixture change, or tests that would pass before the change. | The failure case only. | Failure, null, intra-wave ordering, guard-abort, and the `done === total` no-double-commit cases are all pinned, and the per-task accounting invariant is re-asserted. |
| Interface & readability | ×1 | The commit prompt is duplicated between the two call sites, or `COMMIT_INSTRUCTIONS` is restructured. | Works but drifts from the file's schema/comment style. | `COMMIT_SCHEMA` matches the neighbouring schema style, the flightlog line matches the existing prompt idiom, and no prompt text is duplicated. |
| Assumptions & docs | ×1 | The ordering rationale is left unexplained in the script. | Mentioned in passing. | The why-after-the-guards reasoning and the deliberate no-`break` choice are both recorded as *why* comments, and the notes/gotchas prose is updated to match the new position. |
