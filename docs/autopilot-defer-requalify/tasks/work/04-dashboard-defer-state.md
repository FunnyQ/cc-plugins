# WORK-04: Requalify rows in the fleet dashboard

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: work/03
> **Blocks**: work/06
> **Status**: todo

## Goal

The dashboard parses and colours the follow-up gate check that autopilot now runs when a
verifier postpones its verdict, instead of dropping those rows into the unknown-role bucket
where they render uncoloured and unranked.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/fleet.ts` (modify) — admit one new agent role and
  let the gate-outcome reader judge it.
- `packages/dispatch/skills/autopilot/scripts/fleet.test.ts` (modify) — cover the new label
  shape and the new outcome path.

## Implementation notes

### What upstream already produces

By the time this task runs, autopilot's binary gate can postpone its verdict when a sibling
task in the same wave is still writing the shared working tree. When it does, the orchestrator
waits for the tree to go quiet and then runs the gate a second time, under an agent label of
the form `requalify:<ref>#<attempt>`, logging with `--role requalify`.

Two properties of that design decide this task's whole scope, and both are deliberate:

- **The attempt number does not change.** A postponement is one attempt with two gate calls, so
  a requalify row carries the same `#<attempt>` as the verify row above it.
- **Neither row announces a postponement.** Both keep the existing end-message contract and lead
  with `PASS` or `FAIL`. A verifier asking to postpone is returning a failure, so it logs
  `FAIL`; whether the postponement was granted is visible only as the presence or absence of the
  requalify row that follows. Nothing in the trail carries a third verdict word, and nothing
  here should invent one.

So this task adds no new visual state, no new colour token, and no change under
`dashboard/dist/`. It makes an existing kind of row — a gate check with a `PASS`/`FAIL` verdict
— parse and rank correctly.

### 1. Admit the role

`KNOWN_ROLES` (~line 13) is a closed `as const` tuple that the `AgentRole` union derives from.
Add `requalify` to it, next to `verify`.

### 2. Parse the label

`REF_ATTEMPT` (~line 97) is:

```js
const REF_ATTEMPT = /^(verify|judge|fix):(.+)#(\d+)$/;
```

Add `requalify` to that alternation. **The branch below it casts the captured group**, roughly
`role: match[1] as "verify" | "judge" | "fix"` — widen that cast in the same edit, or the file
does not typecheck. Without this change `requalify:alpha/beta#1` matches nothing, falls through to the
unknown-role path, and the row loses its ref and attempt entirely.

### 3. Rank it in the role progression

`ROLE_PROGRESS` (~line 322) maps a role to an ordinal, used to order rows within one ref and
attempt so successive roles never close each other's open rows. It currently reads
`dev: 0, review: 1, fix: 2, verify: 3, judge: 4`. Insert `requalify` between `verify` and
`judge` and renumber, giving `dev: 0, review: 1, fix: 2, verify: 3, requalify: 4, judge: 5`.
That is the real execution order: the second gate check runs after the first and before scoring.

A role absent from this map is left alone by the ordering logic, so skipping this does not
throw — it silently mis-sequences a requalify row against the verify row it follows at the same
attempt number.

### 4. Let the gate-outcome reader judge it

`gateOutcome()` (~line 290) handles the judge role, then early-returns for everything else:

```js
if (row.role !== "verify") return undefined;
```

A requalify row would therefore never receive an outcome at all — its `PASS`/`FAIL` would go
unread and the row would render uncoloured, which is a worse failure than mis-colouring because
nothing looks wrong. Widen that guard to admit `requalify` alongside `verify`. Everything below
it already does the right thing: the leading-verdict regex is authoritative, and the
scan-the-prose fallback under it stays a last resort for off-contract messages.

Leave `GateOutcome` as `"passed" | "failed"`. There is no third outcome to represent.

### 5. Nothing else needs to change

`aggregateFleet` derives a task's attempt count as the maximum `attempt` across its entries, so
a requalify row sharing its verify row's attempt number does not inflate it. The SSE layer in
`events-api.ts` types its rows off `aggregateFleet`'s return and JSON-passes them, so it widens
on its own. The browser modules under `dashboard/dist/` branch on `row.outcome`, which keeps the
two values they already understand.

### 6. Tests

Reuse the existing seams — neither `gateOutcome` nor the render path is exported directly:

- `describe("parseAgentLabel")` (~line 72) is `test.each`-driven over a table asserting a full
  `toEqual` on the parsed object. Add a row for `requalify:alpha/beta#2`, expecting role
  `requalify`, ref `alpha/beta`, attempt `2`. A sibling block asserts that unknown labels are
  tolerated — the new
  label must no longer belong to that category.
- `describe("gate outcome")` (~line 504) has local `verifyNote(message)` and `outcomeOf(entries)`
  helpers; the latter runs `aggregateFleet` and reads `.outcome` off the first gate row. Add
  cases for a requalify row: a leading `PASS` reads as passed, a leading `FAIL` as failed, and a
  leading `PASS` still wins over a `0 fail` quoted in the test summary that follows it. That
  last case is the exact regression the prose-scanning fallback causes; it is already covered
  for the verify role, so mirror it.
- Add one case proving a verify row and a requalify row at the **same** attempt each receive
  their own outcome rather than one overwriting the other.

## Acceptance criteria

- [ ] `requalify` is a member of `KNOWN_ROLES` and therefore of the `AgentRole` union.
- [ ] `requalify:<ref>#<attempt>` parses to role `requalify` with the correct ref and attempt,
      and the widened cast on that branch keeps the file typechecking.
- [ ] `ROLE_PROGRESS` ranks `requalify` after `verify` and before `judge`, with the other
      entries renumbered so the sequence stays contiguous.
- [ ] `gateOutcome()` reads a `PASS`/`FAIL` verdict off a requalify row using the same
      authoritative leading-verdict rule it applies to a verify row.
- [ ] `GateOutcome` still has exactly two values, and no new state class, colour token or
      `aria-label` branch was added under `dashboard/dist/`.
- [ ] A verify row and a requalify row sharing one attempt number each carry their own outcome,
      and the task's attempt count is unchanged by the second row.
- [ ] The label-parsing table and the gate-outcome block both cover the new role, including a
      leading verdict that contradicts prose appearing later in the same message.

## Verification

- [ ] `bun test packages/dispatch/skills/autopilot/scripts/` passes with 0 failures and a total
      test count strictly greater than the count before this task.
- [ ] `bun test packages/dispatch/skills/autopilot/dashboard/dist/modules/` passes with 0
      failures — this task changes nothing there, so any change in that result is a regression.
- [ ] `grep -n 'requalify' packages/dispatch/skills/autopilot/scripts/fleet.ts` shows it at four
      distinct sites: the known-roles tuple, the label regex, the role-progress map, and the
      gate-outcome guard.
- [ ] `git status --short -- packages/dispatch/skills/autopilot/scripts/fleet.ts packages/dispatch/skills/autopilot/scripts/fleet.test.ts docs/autopilot-defer-requalify/tasks/work/04-dashboard-defer-state.md`
      shows all three paths dirty.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | The regex gained the role but the cast did not, so the file fails to typecheck; or the outcome guard stayed narrow and requalify rows go unjudged | All four sites edited, but the progress map was appended rather than inserted, so the second gate check ranks after scoring | All four sites edited coherently: role admitted, label parsed, ranked between the first check and scoring, and its verdict read |
| Test coverage | ×2 | No test for the new label or the new outcome path | The happy path is asserted, so a narrow outcome guard would still pass | Label, both verdicts, the leading-verdict-versus-prose case, and two gate rows at one attempt all covered |
| Interface & readability | ×1 | A parallel role list or a second regex introduced beside the existing ones | Edits land in the right places but the renumbering is skipped, leaving a gap or a tie | Every edit extends the existing closed set in its own idiom; the map stays contiguous |
| Assumptions & docs | ×1 | The renumbering reads as unexplained churn | A comment restates the new ordinal | A comment says why the second gate check sits between the first and scoring |

## Out of scope

- **A third gate outcome, a new row state, colour token or `aria-label` branch** — Deferred.
  Reason: upstream deliberately emits no third verdict word, so there would be nothing to parse
  and the state would be permanently unreachable.
- **`packages/dispatch/skills/autopilot/scripts/events-api.ts`** — Deferred. Reason: it types
  its rows off the aggregator's return value and JSON-passes them, so it widens on its own.
- **Anything under `packages/dispatch/skills/autopilot/dashboard/dist/`** — Deferred. Reason:
  those modules branch on an outcome value that keeps its existing two-value shape.
- **Reusing the plain verify label for the second gate check instead of adding a role** —
  Rejected, not deferred. Two rows would then tie in the role progression, and the comment above
  that map warns those rows must never close each other.
