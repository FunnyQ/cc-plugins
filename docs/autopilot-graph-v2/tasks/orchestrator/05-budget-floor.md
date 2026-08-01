# ORCHESTRATOR-05: budget floor

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/orchestrator-contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: orchestrator/04
> **Status**: done

## Goal

A run with a declared token budget stops dispatching new work once its remaining balance falls below a
configured floor, and says so loudly instead of stopping silently.

**This is a best-effort dispatch cutoff, not a guarantee against mid-task exhaustion.** The check runs
between waves, and it compares the remaining balance against the floor — it does not estimate what the
next wave will cost. A wave dispatched with the balance just above the floor can still exhaust the budget
while running. Making that impossible would need a per-task cost estimate and a reserve, which nothing
here provides and which is out of scope. What the floor buys is a bounded, reported stop at the one point
in the loop where stopping is free, instead of an unbounded run that dies wherever it happens to run out.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — inside the fenced
  ```` ```javascript ```` block: a new config field, a defensive read of the Workflow `budget` global, and a
  stop-before-dispatch check in the wave loop.
- The same file, **outside** the fenced block (modify) — the prose this change makes stale. The gotcha that
  enumerates the terminal conditions must now include the budget stop, and the new config field needs its
  behaviour and its off-by-default value described where the other config fields are. This is the last
  orchestrator change, so also confirm the wave-loop diagram in the "Context" section matches the shipped
  loop end to end. Prose that contradicts the script is worse than no prose: the next author trusts it.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify) — inject a `budget`
  stub and cover the trip, the two off states, and the absent-global case.

## Implementation notes

**Every edit to the executable script must land INSIDE the fenced ```` ```javascript ```` block.**
The prose corrections listed under "Files to create / modify" are the deliberate and only exception —
they belong outside the block by definition. The fixture locates the script by
string search — `doc.indexOf("```javascript")` to the next `"\n```"` — and runs the slice through
`new Function`. A change written in the prose around the block is invisible to both the runtime and the
test, and will look like it worked.

### What `budget` is, and why every read must be defensive

`budget` is a Workflow runtime global, not something the script constructs:

```js
budget = { total: number | null, spent(): number, remaining(): number }
```

`total` is `null` whenever the user declared no token target, and `remaining()` then returns `Infinity`.
Two independent absences therefore have to read as "no floor" rather than as an error:

- **The global may not exist at all.** The fixture drives the script through `new Function` with an
  explicit parameter list, so an un-injected `budget` is `undefined` and a bare `budget.total` throws.
  Guard with `typeof budget === 'undefined'` before touching it — a plain `budget?.total` still throws on
  an undeclared identifier in this position.
- **`total` may be `null`.** No declared target means no floor to enforce. Test it as
  `budget.total === null`, never as `!budget.total` — a real total of `0` is a budget that is fully
  spent, which must still trip the floor rather than silently disable it.

### The config field

Add beside the other run-shaping fields:

```js
  budgetFloor:           0,     // output-token floor: below this, stop dispatching new tasks (0 = off)
```

Default `0` = off, deliberately. Two reasons, and both belong in a comment:

- `budget.total` is `null` unless the user declared a token target, so a nonzero default would be dead
  config on most runs.
- A floor that fires unannounced manufactures a new stall class. Every other way this run can stop is
  something the operator asked for or a defect being reported; a surprise budget stop would be neither.

Normalise it once, next to where the other numeric config is coerced:

```js
// Interpolated into an operator-facing reason string and compared against a token
// count, so a negative or fractional value would render an incoherent one.
const BUDGET_FLOOR = Math.max(0, Math.trunc(Number(CFG.budgetFloor ?? 0)) || 0)
```

Then one predicate, so the wave loop stays readable:

```js
// Returns the remaining budget when it has fallen below the floor, else null.
// Both "no floor configured" and "no budget declared" are null — not a throw and
// not a stop.
const budgetBelowFloor = () => {
  if (BUDGET_FLOOR <= 0) return null
  // `total === null` is the documented "no target declared" value. Do NOT use
  // a falsy test: a legitimate total of 0 would disable a configured floor at
  // exactly the moment it matters most.
  if (typeof budget === 'undefined' || !budget || budget.total === null) return null
  const left = budget.remaining()
  return left < BUDGET_FLOOR ? left : null
}
```

### Where the check goes — this ordering is the whole design

Inside the wave loop, place it **after the commit agent call** and **immediately before the
`parallel()` dispatch**. Both halves of that are load-bearing:

- **After the commit.** The wave that just finished has already been verified, judged, and marked done.
  Stopping before its commit would strand real completed work in a dirty tree for no reason.
- **Before the dispatch.** This is the only point in the loop where stopping costs nothing. A wave is a
  barrier, so nothing is in flight here — "let in-flight tasks finish" needs no machinery at all, it is
  simply where the gap already is. Checking anywhere inside the per-task pipeline would mean abandoning
  a task mid-write, which manufactures exactly the unknown on-disk state the rest of this script exists
  to prevent.

`fresh` has already been computed by that point, so the check can name the tasks it declined to start.

```js
const left = budgetBelowFloor()
if (left !== null) {
  const reason = `budget floor reached before wave ${wave} dispatch: ${left} of ${budget.total} output tokens remain, `
    + `below the configured floor of ${BUDGET_FLOOR}. Not dispatched: ${fresh.map(f => f.ref).join(', ')}. `
    + `${c.total - c.done} of ${c.total} task(s) remain unfinished. No task was parked and nothing is in flight — `
    + `raise or clear the budget floor, or grant more budget, then re-run autopilot to resume.`
  log(reason)
  escalations.push({ task: '(budget)', attempt: 0, infrastructure: true, parked: false, reason })
  break
}
```

### Why an escalation and not a clean return

Stopping here leaves unfinished tasks. A run that ends with unfinished tasks and reports a clean result
is precisely the silent-failure class every other terminal condition in this loop is written to avoid —
the same reasoning that makes an empty ready set with unfinished work a reported stall rather than a
quiet finish. So it takes the synthetic-escalation shape the other non-task conditions use:
`attempt: 0`, `infrastructure: true`, `parked: false`.

Two consequences to accept rather than work around:

- `parked: false` is honest. No task's status was touched, so nothing needs a hand-reset — but the run
  did not finish, and the operator has to be told which work never started. The reason string carries
  that list.
- The post-loop commit is skipped, because its guard is `escalations.length === 0`. That is the existing
  guard's correct behaviour and this task does not relax it: the wave's own commit already ran just
  before the check, so the only thing left uncommitted is nothing.

### Out of scope for this task

- Any change to the `escalations.length === 0` commit guard, in either the wave or the post-loop commit.
- Stopping, pausing, or parking a task that is already running. Never park mid-task on budget.
- Any per-task or per-attempt budget accounting, or estimating a task's cost before dispatch.
- Changing the retry ladder, the schemas, the scout, or the guard order established earlier in this plan.
- Any change to how the main agent reports the returned escalations.

## Acceptance criteria

- [x] A new config field defaults to `0`, and with it at `0` the run's behaviour is identical to current
      behaviour — no budget read affects any decision.
- [x] The field is normalised so a negative or fractional value cannot reach the comparison or the
      reason string.
- [x] The budget read tolerates a completely absent `budget` global without throwing, using a
      `typeof` guard rather than optional chaining on the bare identifier.
- [x] A `budget.total` of `null` never trips the floor, at any configured floor value.
- [x] With a floor configured and the remaining budget below it, the loop pushes exactly one escalation
      with task `(budget)`, `attempt: 0`, `infrastructure: true`, `parked: false`, then breaks.
- [x] That escalation's reason states the remaining budget, the configured floor, the refs that were
      ready but not dispatched, and the count of unfinished tasks.
- [x] The check runs **after** the wave's commit agent call and **before** the `parallel()` dispatch, so
      the finished wave is committed and no ready task is started.
- [x] When the floor trips, no dev, verify, judge, or mark-done agent runs for that wave.
- [x] No task's status is written when the floor trips — nothing is parked and nothing is left
      `in-progress` by this code path.
- [x] The `escalations.length === 0` guard on both commit paths is unchanged.
- [x] Every change to the executable script sits inside the fenced ```` ```javascript ```` block;
      the only edits outside it are the prose corrections listed above.

- [x] The terminal-conditions gotcha in `orchestrator.md` includes the budget stop, the new config field
      is documented alongside the others, and the wave-loop diagram in the Context section matches the
      shipped loop end to end.

- [x] An undeclared budget is detected as `budget.total === null` specifically; a `total` of `0` does
      **not** disable a configured floor, and has its own test.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` green.
- [x] `bun test packages/dispatch/skills/autopilot/scripts/` green — no regression in the sibling
      dashboard suites.
- [x] The fixture injects a `budget` stub through the `new Function` parameter list, with a scenario
      field supplying `total` and `spent` and a `remaining()` derived from them; omitting the field
      leaves the parameter `undefined` so the absent-global path is exercised by every pre-existing test.
- [x] A fixture case with a floor above the remaining budget asserts a single `(budget)` escalation with
      `infrastructure: true` and `parked: false`, and that no label beginning `dev:` was recorded.
- [x] A fixture case with the floor at its default and a nearly-exhausted budget asserts the run
      completes normally with no `(budget)` escalation.
- [x] A fixture case with a floor configured and `total: null` asserts no `(budget)` escalation.
- [x] A fixture case asserts the reason string contains the undispatched refs and the configured floor.
- [x] `bun -e "const d=await Bun.file('packages/dispatch/skills/autopilot/references/orchestrator.md').text(); const s=d.indexOf('\`\`\`javascript'); const b=d.indexOf('\n',s)+1; const e=d.indexOf('\n\`\`\`',b); new Function(d.slice(b,e).replace(/^export const meta/m,'const meta'))"`
      exits 0 — the block still parses as a function body.
- [x] `grep -c "budgetFloor" packages/dispatch/skills/autopilot/references/orchestrator.md` is ≥ 2 (the
      config field and its normalisation), confirming the change landed in the script rather than only
      in prose.
- [x] `grep -n "escalations.length === 0" packages/dispatch/skills/autopilot/references/orchestrator.md`
      still shows two occurrences — the wave commit guard and the post-loop commit guard, both untouched.

## Eval rubric

Anchors and scoring notes are in `../_context/rubric.md`; the bar below is the one that gates this task.

> Score each dimension 0–5. Pass needs a weighted average **> 4.0** on the 0–5 scale.
> `Correctness < 4` is an automatic veto regardless of the average.

| Dimension | Weight | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| Correctness | ×3 | The check throws on an absent global, trips with no declared budget, or sits before the commit or inside the task pipeline. | Trips correctly but a boundary is wrong (a `null` total, a zero floor, or an unnormalised value reaching the reason string). | Placement, both off states, the absent global, and the escalation shape are all exactly as specified. |
| Test coverage | ×2 | No test, or tests that would pass without the change. | The trip is tested but neither off state is. | Trip, zero floor, `null` total, absent global, and the no-dispatch assertion are all covered, and each test would fail without the change. |
| Interface & readability | ×1 | The budget read inlined into the loop condition, or the floor compared unnormalised. | Works but the wave loop grows hard to scan. | One named predicate and one normalised constant, so the loop body reads as a single guard alongside its neighbours. |
| Assumptions & docs | ×1 | The off-by-default rationale and the placement rationale are left silent. | Noted somewhere. | Both are *why* comments next to the code, and the new config field's comment matches the style of its neighbours. |
