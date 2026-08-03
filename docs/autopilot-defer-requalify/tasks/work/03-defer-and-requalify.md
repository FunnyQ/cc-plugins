# WORK-03: Defer-and-requalify gate layer

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/orchestrator-anatomy.md`
>
> **Depends on**: work/02
> **Blocks**: work/04, work/05
> **Status**: todo

## Goal

A verifier that meets red output caused by a sibling task still writing the shared tree can
postpone its verdict, wait for the tree to go quiet, and re-run its commands once — and can
never use that postponement to waive a non-zero exit.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — inside the single
  ` ```javascript ` fence: `GATE_SCHEMA`, `verifyPrompt`, and the gate-handling block of
  `executeTask`.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify) — new
  scenarios for the defer path and every guard.

## Implementation notes

### What already exists

The wave tree watch is in place: a per-wave object created just before the wave's `parallel()`
dispatch and threaded through the guarded wrapper into `executeTask`. It exposes:

```js
watch.size      // how many tasks this wave dispatched
watch.quiet()   // Promise that resolves at the next moment no writer is active
watch.active()  // how many writers are running right now — takes no argument
```

Writers are the counted mutation windows: the dev step and the final-review round, the
mark-done transition, and every park path. This task consumes that interface unchanged — it
adds no new writer and no new member.

`active()` needs no ref argument. A task asking the question has already left the writer set,
because its own dev step returned before its gate ran, so a non-zero count always means some
*other* task is writing.

### 1. `GATE_SCHEMA` gains an optional `deferred`

```js
const GATE_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },     // every Verification command + Acceptance criterion passed
    deferred: { type: 'boolean' },   // the red output looks like a sibling's in-flight edits
    summary: { type: 'string' },     // raw evidence: commands run, exit codes, failing output
  },
  required: ['passed', 'summary'],
}
```

`deferred` stays **out** of `required` on purpose: a verifier that omits it degrades to exactly
today's two-state behaviour rather than failing schema validation.

### 2. The four guards

A third gate state is otherwise a button a cheap verifier will press whenever a red command is
inconvenient. Every condition below is checked in code, not asked for in prose:

```js
const SIBLING_MARKER = 'SUSPECTED SIBLING INTERFERENCE'

const deferralAccepted = (gate, watch) =>
  gate.passed === false
  && watch.size > 1
  && typeof gate.summary === 'string'
  && gate.summary.includes(SIBLING_MARKER)
  && watch.active() > 0
```

- **`passed === false`** — a deferral only ever postpones a failure. A gate that claims both a
  pass and a deferral is incoherent; discard the deferral and let the pass stand.
- **`watch.size > 1`** — a task dispatched alone in its wave has no sibling to blame.
- **the marker** — forces named evidence into `summary`, which is also what lands in the audit
  trail and in the retry feedback.
- **`watch.active() > 0`** — the load-bearing one. **Write a why-comment for this one.**
  Wave size is *historical*: it says this wave once had siblings, not that any of them is
  writing now. Without this check, a verifier whose siblings have all finished gets `quiet()`
  resolving instantly and wins a free re-run of a red command — so a flaky failure, or its own
  genuine one, can pass on the second roll with nothing rewritten in between. That is strictly
  weaker than simply failing the attempt, which is the behaviour this whole mechanism claims to
  improve on.

A rejected deferral is **discarded**, not converted: the gate is then handled exactly as its
own `passed` value dictates, which for the three evidence guards means the ordinary failure
path. No second agent is spawned in any rejected case.

### 3. Gate handling in the attempt loop

Slot this between the existing `if (!gate)` infrastructure guard and the existing
`if (!gate.passed)` block:

```js
let gate = await agent(verifyPrompt(ref, path, attempt),
  { label: `verify:${ref}#${attempt}`, phase: 'Execute', model: MODEL.verify, schema: GATE_SCHEMA })
if (!gate) { /* unchanged infrastructure-failure path */ }

if (gate.deferred && deferralAccepted(gate, watch)) {
  await watch.quiet()
  const requalified = await agent(verifyPrompt(ref, path, attempt, { requalify: true }),
    { label: `requalify:${ref}#${attempt}`, phase: 'Execute', model: MODEL.verify, schema: GATE_SCHEMA })
  if (!requalified) {
    const cause = `requalification did not run or did not return a verdict on attempt ${attempt}`
      + ` — the requalify agent produced no structured result.`
    return infrastructureFailure(ref, attempt, cause, await parkBlocked(ref, path, cause, watch))
  }
  // One defer per attempt: the requalify verdict is final, so its own `deferred`
  // is dropped rather than re-entering this branch.
  gate = { ...requalified, deferred: false }
}

if (!gate.passed) { /* unchanged: push onto attempts[], continue */ }
```

Properties this shape buys, all of which the tests must hold:

- **A defer consumes no attempt.** It is one attempt with two verify calls. `attempt` is not
  incremented and nothing is pushed onto `attempts[]` until the requalify verdict is known.
- **A failing requalify falls through to the existing `continue`**, which is already the dev
  retry path. There is no new retry machinery.
- **No third state escapes the task.** The guarded wrapper still returns pass/fail, so wave
  reconciliation, the held-back path list, the commit agents and the divergence detector are
  untouched.
- **A null requalify is an infrastructure failure, not a plain fail** — same reasoning as the
  existing null-gate guard: nothing was verified, so retrying dev would run against an unknown
  state. Note the `watch` argument on that `parkBlocked` call: the park helper now takes the
  watch and wraps its own body as a counted window, so every call site must pass it. Omitting it
  hands `undefined` to the wrapper and turns the intended infrastructure failure into a thrown
  exception. Cover this path with a test.

Note `agent({schema})` can also **throw** rather than return null. That is already handled for
this whole pipeline by the guarded wrapper's catch; do not add a local try around these calls.

### 4. `verifyPrompt` gains a mode

Signature becomes `verifyPrompt(ref, path, attempt, opts = {})`, reading `opts.requalify`.
Keep every existing instruction; add a closing block that differs by mode.

**Normal mode** must convey, in substance:

- Tasks in this wave run in PARALLEL in one shared working tree.
- Never clean, restore, reset, stash or otherwise rewrite the tree to obtain a clean run.
- Run every Verification command exactly as written. Any non-zero exit is `passed=false`.
- If — and only if — the evidence points at a sibling task's in-flight edits as the cause, also
  return `deferred=true`, prefix `summary` with the exact string
  `SUSPECTED SIBLING INTERFERENCE`, and give the exact command, exit code, failing cases and
  the concrete evidence for that attribution. The commands will then be run again once the
  other tasks have stopped writing.
- Deferring waives nothing and never changes a verdict on its own. An unsupported deferral is
  counted as a plain failure.

**Requalify mode** replaces that last part with: this is the requalify run, every other task in
this wave has stopped writing so the sibling explanation no longer applies, any non-zero exit
is `passed=false`, and `deferred` is ignored on this run.

### 5. Labels and the audit trail

- The requalify agent's label is `requalify:${ref}#${attempt}`, and in requalify mode the
  prompt's flightlog calls use `--role requalify`. Normal mode keeps `--role verify`.
- **Both modes keep the existing `PASS`/`FAIL` end-message contract, unchanged.** A verifier
  requesting a deferral is returning `passed=false`, so it logs `FAIL`. Do not invent a third
  leading word.

  This is not cosmetic, and it is the reason a deferral leaves no mark of its own in the trail.
  The agent writes its end message **before** it returns, so the orchestrator has not yet run
  the guards. A message announcing a deferral would therefore survive a deferral the guards go
  on to refuse, and the trail — and every dashboard reading it — would show a state the
  pipeline never granted. Refusals are common by design; three of the four guards exist
  precisely to produce them.

  The orchestrator's decision *is* recorded, by the only mark the orchestrator itself controls:
  whether a `requalify:` row follows. A granted deferral shows `FAIL` then a requalify verdict;
  a refused one shows `FAIL` and nothing after it. Both are true.
- The dashboard must learn the new role so requalify rows are parsed and coloured like the gate
  rows they are. That work belongs to a later task in this bucket, not here. Until it lands a
  requalify row renders uncoloured, which is expected and is not a reason to widen this task.

One free win worth a comment: `gate.summary` is already pushed onto `attempts[]` and flows
through the attempt-history renderer into the **retrying dev agent's** feedback string. So a
failed requalify hands the next dev the sibling-interference evidence verbatim, at no cost.

### 6. Tests

Add scenarios to the deterministic fixture. Its stub dispatches on the agent label, so a
`requalify:` label needs a branch that returns a per-ref queued result, mirroring how `verify:`
is already handled. Use the held-writer knobs the fixture already provides to control when a
sibling's writer releases.

Cover:

- Defer, then a **passing** requalify: the task completes, and the dev step ran exactly once.
- Defer, then a **failing** requalify: falls through to a dev retry, and the defer consumed no
  attempt.
- Defer while a sibling's writer is **held**: the requalify agent is not spawned until that
  writer is released. Assert on call ordering, not just on the final result — this is the test
  that would hang or pass vacuously if the wait were wired wrong.
- Each of the four guards: the deferral is discarded, the gate is handled by its own `passed`
  value, and **no second verify agent is spawned**. Assert the absence of the `requalify:` label.
- `deferred` returned by the **requalify** call is ignored — no third verify call.
- Every task in a wave asks to defer. **The last one's request is necessarily refused**, and the
  test asserts exactly that: by the time the final task's gate returns, every sibling has left
  its writer window, so the live count is zero and the load-bearing guard rejects. The earlier
  requests are accepted and their waiters all resolve together at the zero crossing. The wave
  completes without hanging.

  This is a property of the design, not a gap. A task whose siblings have all finished is
  already verifying against a settled tree, so it has nothing to wait for — which is precisely
  what the guard encodes. State it in the test's name so a later reader does not "fix" it.
- **Writer accounting, proved through the wait.** The tree watch's count has no observable
  effect until something waits on it, so a deferral is the first place its bookkeeping can be
  tested at all. Use the fixture's per-window hold knobs — `doneHolds` for the mark-done step,
  `parkHolds` for the park, both keyed by task ref and awaited by the stub before it returns.
  Hold a sibling inside its **mark-done** step, and separately hold a sibling inside its
  **catch-path park** — the one reached when a dev step throws, which `devHolds` plus the
  existing `devThrows` knob can stage — and in each case assert the requalify agent is not
  spawned until that hold releases. These two tests are the
  only proof that those windows are counted; without them a missing wrapper on either passes
  silently.

## Acceptance criteria

- [ ] `GATE_SCHEMA` carries an optional boolean `deferred`, and its `required` list is still
      exactly `['passed', 'summary']`.
- [ ] An accepted deferral awaits the tree watch's quiet signal and then issues exactly one
      further verify agent, labelled `requalify:<ref>#<attempt>`, whose verdict is final.
- [ ] A deferral consumes no attempt: the same `attempt` number covers both verify calls, and a
      failing requalify falls through to the existing dev-retry `continue`.
- [ ] All four guards — verdict is a failure, wave size above one, `SUSPECTED SIBLING
      INTERFERENCE` present in `summary`, and another writer live right now — are enforced in
      the script itself, not only asked for in prompt text.
- [ ] A rejected deferral is discarded and the gate is handled by its own `passed` value, and no
      requalify agent is spawned in any rejected case.
- [ ] A `deferred` flag returned by the requalify call is ignored, and a null requalify result
      is treated as an infrastructure failure rather than a plain gate failure.
- [ ] `verifyPrompt` takes a mode: normal mode states the parallel-tree, no-restore,
      no-waiver and marker rules; requalify mode states that the sibling explanation no longer
      applies and that `deferred` is ignored.
- [ ] The guarded task wrapper still returns only pass/fail shapes — no deferral state reaches
      wave reconciliation, the held-back list, the commit agents or the divergence detector.
- [ ] Both verify modes still log an end message leading with `PASS` or `FAIL`; no message
      announces a deferral, so a refused deferral cannot leave a granted-looking audit entry.
- [ ] Tests hold a sibling inside its mark-done step and inside its catch-path park, and prove
      the requalify waits for each — the only observable proof that those windows are counted.

## Verification

- [ ] `bun test packages/dispatch/skills/autopilot/scripts/` passes, with a strictly larger
      total test count than the 198 recorded before this task.
- [ ] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` passes
      and its output names the new defer, requalify, guard and held-writer cases.
- [ ] `git status --short -- packages/dispatch/skills/autopilot/references/orchestrator.md packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts docs/autopilot-defer-requalify/tasks/work/03-defer-and-requalify.md`
      shows all three paths dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | The live-writer check is absent, any guard lives only in prompt text, or a deferral can turn a non-zero exit into a pass | Three of the four guards are enforced, or all four are present but the live-writer check reads a count sampled after the wait rather than at the verdict, or a deferral consumes an attempt | All four guards enforced in code and evaluated at the verdict, the requalify verdict is final, and no deferral state escapes the task pipeline |
| Test coverage | ×2 | Only the happy defer→pass path is tested | Guards tested by outcome but nothing asserts the absent requalify agent or the held-writer ordering | Every guard downgrade asserts no second agent spawned, and the held-writer case asserts call ordering, not just the final result |
| Interface & readability | ×1 | The gate block becomes a nested tangle, or a second parameter is threaded beside the watch | Readable but the guard predicate is inlined and repeated | One named predicate, one object threaded, and the new branch reads in the existing file's idiom |
| Assumptions & docs | ×1 | The live-writer check carries no explanation | A comment restates what the code does | A why-comment explains the free-re-run hole the live-writer check closes, in the file's existing register |

## Out of scope

- The dashboard's label parsing, role ranking and gate-outcome reading for the new role —
  Deferred. A later task in this bucket owns the dashboard, and splitting it out keeps this task
  inside the orchestrator script. Note there is **no** new verdict word for it to learn: both
  modes keep the `PASS`/`FAIL` contract, so no new row state or colour token is involved either.
- Adding, removing or re-scoping counted writer windows — Deferred. The tree watch and its
  writer accounting arrived with this task's dependency and are consumed here as-is.
- Re-verifying a whole wave after every writer settles — Deferred. It would remove the residual
  race where a sibling starts a retry just after the quiet signal releases a waiter, but it is
  a redesign of the wave loop rather than a change to one task's gate.
- The design-notes entries explaining why this mechanism exists — Deferred to a later task in
  this bucket.
