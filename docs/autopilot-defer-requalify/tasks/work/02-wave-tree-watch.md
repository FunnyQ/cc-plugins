# WORK-02: Wave tree-watch and writer accounting

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
> - `../_context/orchestrator-anatomy.md`
>
> **Depends on**: work/01
> **Blocks**: work/03
> **Status**: done

## Goal

The orchestrator script can answer "is any other task in this wave mutating the tracked tree
right now?", and can await the next moment when none is — so a later capability can hold a
verification re-run until the shared working tree goes quiet.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — add
  `makeTreeWatch()` and `withWriter()` inside the ` ```javascript ` fence, create one watch per
  wave, thread it through the task pipeline, and wrap every window that mutates the tracked
  tree.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify) — add the
  `devHolds`, `parkHolds` and `doneHolds` scenario knobs, then the concurrency tests that use them.

## Implementation notes

This task delivers the **mechanism only**: a way to observe writers and await quiet. It
introduces no new gate semantics, no second verification call, and no prompt change. Nothing in
the run's behaviour should change — the same agents run in the same order with the same text.
What lands is the accounting a later capability will read.

### The two helpers

Add both near the other small helpers in the fence, above the per-task pipeline. Inline
verbatim:

```js
// How many writers in this wave are mutating the tracked tree right now. A task
// that fails its gate retries dev and writes again, so "all first devs returned"
// is not a stable notion of quiet — this is a live count whose waiters resolve on
// the next zero-crossing, not a one-shot barrier.
const makeTreeWatch = (size) => {
  let writers = 0
  let waiters = []
  return {
    size,
    enter: () => { writers++ },
    leave: () => {
      if (--writers === 0) { const w = waiters; waiters = []; w.forEach(r => r()) }
    },
    active: () => writers,
    quiet: () => writers === 0 ? Promise.resolve() : new Promise(r => waiters.push(r)),
  }
}

const withWriter = async (watch, fn) => { watch.enter(); try { return await fn() } finally { watch.leave() } }
```

**This is the final shape — five members, no more.** Two of them have no caller in this task,
and both exist so the watch's contract is settled before its consumer lands rather than being
renegotiated mid-plan:

- `active()` is the live writer count, read by the capability that decides whether a
  verification re-run is warranted; it needs to know whether *any* writer is running at the
  moment a gate verdict arrives. It takes no argument on purpose. A task asking the question has
  already left the writer set, so a non-zero count always means somebody else.
- `size` is the number of tasks this wave dispatched, which the same consumer needs in order to
  tell a genuinely parallel wave from a lone task. The wave loop knows it as `fresh.length` at
  the creation site, so it is passed in there.

Give each a comment naming the consumer, so neither reads as dead code.

### Lifecycle: one watch per wave, passed explicitly

Create the watch **inside the wave loop**, immediately before the `parallel(...)` dispatch:

```js
const watch = makeTreeWatch(fresh.length)
const results = await parallel(fresh.map(item => () => runTaskGuarded(item, watch)))
```

Then thread it down: `runTaskGuarded(item, watch)` → `executeTask(item, watch)` →
`parkBlocked(ref, path, reason, watch)`.

**Do not hoist it to module scope**, and record why in a comment. Be accurate about the reason:
a module-scoped watch's *waiting* would still work, because later `enter()` calls increment the
same counter and `quiet()` registers a waiter whenever that counter is non-zero. The reason is
`size`. It is a per-wave fact, so a surviving watch either reports a stale dispatch count or has
to be mutated between waves — and the consumer that reads it uses it to decide whether a task
had any sibling at all. A wrong answer there silently changes which deferrals are accepted.

Per-wave scope also keeps the object's lifetime equal to the thing it describes: `parallel()`
awaits every task thunk before the loop advances, so an instance created there is provably
unobservable to any later wave, and no cross-wave state can accumulate.

### What counts as a writer

Wrap each of these with `withWriter`, because each mutates the **tracked** tree:

- All three dev-agent branches in the attempt ladder — the external-engine rung, the configured
  external engine, and the Claude dev agent.
- The `runFinalReview(...)` call, wrapped as **one** window around the whole awaited call. Its
  fixer writes the tree, and the fixer cannot be wrapped separately from outside — the fan-out
  and the fixer are both inside that function, and splitting them would mean threading the watch
  into it for no gain.

  Its read-only review lenses are therefore *enclosed* by that aggregate window. That is
  intended, not a contradiction with the exclusion below, which forbids giving a review-lens
  `agent()` call its **own** wrapper. The cost of the aggregate window — the quiet signal stays
  held for the whole review round — is free here: the final-review task is dependency-serialized
  and runs alone in its wave, so no sibling is ever waiting on it.
- The mark-done agent, which runs the script that rewrites `Status: done` and ticks every gate
  box in the task file.
- `parkBlocked` itself. Wrap the body **inside that function**, not at its call sites: it is
  reached from five places, and one of them is the catch inside the guarded task wrapper, which
  runs *outside* the task pipeline entirely. Anything scoped to the inside of the pipeline
  misses it, and that path is precisely when a sibling is rewriting a task file while other
  tasks are still running.

Wrap **none** of these, and say so in a comment where it is not obvious:

- **The rubric judge.** Its scorer only reads the task file; its `--log` output goes to the
  self-gitignored flightlog directory. It is not a tree writer, and counting it would make the
  quiet signal fire later than it should for no gain. This is a deliberate exclusion, and a
  later reader will otherwise "fix" it.
- **The verifier, and each individual review-lens call.** They must not write at all; wrapping
  them would
  legitimise the idea that they might.

### Why this cannot deadlock

State this reasoning in a comment on the watch, because it is the property the whole design
rests on:

- A task that awaits `quiet()` has already left the writer set — its own mutation window closed
  before its gate ran — so it never waits on itself.
- Every writer leaves through a `finally`, so a throwing writer still decrements. The count
  cannot strand.
- If every task in a wave awaits at once, no writer remains, `writers` is `0`, and `quiet()`
  returns an already-resolved promise rather than registering a waiter.

### Test harness knobs

Extend the scenario type with three knobs. Each is keyed by task ref and holds a promise the
stub awaits before returning, so a test decides exactly when a writer leaves its window:

```ts
/** Keyed by ref; the stubbed dev step awaits this before returning. */
devHolds?: Record<string, Promise<void>>;
/** Keyed by ref; the stubbed park agent awaits this before returning. */
parkHolds?: Record<string, Promise<void>>;
/** Keyed by ref; the stubbed mark-done agent awaits this before returning. */
doneHolds?: Record<string, Promise<void>>;
```

Wire `devHolds` into the stub's `dev:` / `dev-` branch, `parkHolds` into its `block:` branch,
and `doneHolds` into its `done:` branch. Await the hold **before** the branch's existing
behaviour — for the dev branch, before the `devThrows` check, so a test can hold a writer that
then throws and still observe the catch-path park. A ref with no entry must behave exactly as it
does today.

**One knob per counted window, deliberately.** Each of the three wrapped windows gets a hold, so
the capability that later waits on the quiet signal can prove every one of them is counted.
`doneHolds` has no user in this task — add it anyway rather than leaving that consumer to invent
an undocumented seam.

A small deferred-promise helper (`let release; const held = new Promise(r => release = r)`) keeps
the tests readable. Note that the runtime forbids `Date.now()` and `Math.random()`; these tests
need neither — they sequence on promise resolution, never on elapsed time.

### The tests to add

1. **The watch does not disturb a normal wave.** A multi-task wave with no holds completes with
   the same completed set and the same agent-label order as before the watch existed.
2. **A wave whose every dev step is held, then released, completes.** All holds are released
   after the wave is known to be in flight. This proves the wrapping does not change when a
   wave finishes. It is **not** a deadlock test: nothing in this task awaits `quiet()`, so
   completion depends only on the holds being released, and this would still pass if `leave()`
   never decremented. Leak detection belongs to the capability that waits — do not claim it
   here.
3. **A held catch-path park still reconciles.** Hold a sibling's dev step so it throws into the
   guarded wrapper's catch, hold its park, release both, and assert the task is escalated and
   parked exactly as it is today. This proves the extra wrapping did not break the catch path;
   it does **not** prove the park is counted.

**What these tests deliberately cannot prove, and why.** The count has no observable effect
until something waits on it, and nothing in this task waits. A test that releases a held dev
promise only proves the agent finished; a test that observes the park's label only proves the
park ran, which is equally true with the wrapper removed. So the *accounting* — that dev,
mark-done and the catch-path park each open a counted window — is only testable once a consumer
waits on the quiet signal, and it is asserted there rather than here. Do not manufacture a
test-only accessor on the watch to close that gap: the script exposes nothing to the fixture
today, and a seam added purely to be asserted would be the only such seam in the file.

What this task's tests do own: the threading is correct, the wrapping does not disturb a normal
wave, and the run's shape is unchanged. Note in a comment above them that once a consumer does
await `quiet()`, a miscounted latch will present as a **hang** rather than a failure — so a
timeout in the suite that adds that consumer is a real defect and must never be "fixed" by
raising the limit.

## Acceptance criteria

- [x] `makeTreeWatch(size)` exists in the fence with exactly the five members `size`, `enter`,
      `leave`, `active`, `quiet`; `active()` takes no argument; and `quiet()` returns an
      already-resolved promise when the count is zero rather than registering a waiter.
- [x] The watch is created with the wave's dispatched task count, so `watch.size` reports how
      many tasks share the tree.
- [x] `withWriter(watch, fn)` exists and releases through `finally`, so a throwing `fn`
      still decrements the count and still propagates its error.
- [x] Exactly one watch is created per wave, inside the wave loop before the parallel dispatch;
      no watch is stored at module scope.
- [x] The watch is threaded by explicit parameter through the guarded task wrapper, the task
      pipeline, and the park helper — none of the three reads it from an outer binding.
- [x] All three dev-agent branches, the final-review call, the mark-done agent, and the body of
      the park helper each run inside a `withWriter` window.
- [x] The rubric-judge call, the verifier call, and each individual review-lens call carry
      **no** wrapper of their own — the lenses being enclosed by the single final-review window
      is expected and is not a violation — and the judge's exclusion carries a comment giving
      the reason.
- [x] `orchestrator-script.test.ts` accepts `devHolds`, `parkHolds` and `doneHolds` scenario
      fields, and a ref absent from any of them behaves exactly as it did before.
- [x] The three tests above exist and pass, and the run's agent sequence for a hold-free
      scenario is unchanged from the current behaviour.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/` passes with 0 failures and a total
      test count strictly greater than the 198-test baseline.
- [x] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` passes,
      and completes without hitting a per-test timeout.
- [x] `git status --short -- packages/dispatch/skills/autopilot/references/orchestrator.md packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts docs/autopilot-defer-requalify/tasks/work/02-wave-tree-watch.md`
      shows all three paths dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | The count can strand — an `enter` without a `finally`-`leave`, or the watch hoisted to module scope | Every listed window wrapped except the park helper's body, so the guarded wrapper's catch path runs uncounted | Every listed window counted including the catch-path park; every `enter` released through `finally`; watch created per wave and passed explicitly |
| Test coverage | ×2 | No held-writer test at all, or a test-only accessor bolted onto the watch so the accounting could be asserted here | The three cases exist but the limits are unstated, so a later reader believes the accounting is proved | The three cases pass, and the file says plainly which property each one does and does not establish — the accounting itself is left to the consumer that waits |
| Interface & readability | ×1 | A second coordination primitive or a global added alongside the watch | The helpers work but the threading is inconsistent — some callers read an outer binding | Two small helpers, one explicit parameter chain, matching the fence's existing idiom |
| Assumptions & docs | ×1 | The judge exclusion and the per-wave lifetime left unexplained | A comment notes what the code does rather than why | Comments give the reasons: why per-wave not module scope, why a live count not a barrier, why the judge is excluded, and why a hang becomes the miscount signal once a consumer waits |

## Out of scope

- **A `deferred` field on the binary gate's schema** — Deferred. This task adds no gate
  semantics; it only makes the tree's writer state observable.
- **A second verification call, or any notion of re-running a gate** — Deferred to the
  capability that consumes `quiet()` and `active()`. Adding a caller here would ship a
  half-built decision layer with no guards around it.
- **Any change to prompt text** — Deferred. Not one agent's instructions change in this task,
  which is what makes the hold-free scenarios byte-comparable against current behaviour.
- **Counting the rubric judge as a writer** — Excluded by design, not deferred. Its scorer reads
  the task file and appends only to the self-gitignored flightlog.
