# WORK-02: Usage Attribution

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/types.md`
>
> **Depends on**: work/01
> **Blocks**: work/03
> **Status**: done

## Goal

Pair each agent's token usage to the fleet row that agent produced, and roll the whole
set up by task and in aggregate — as a pure function, with no I/O and no clock.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/usage-attribute.ts` (new) — `attributeUsage` and its helpers
- `packages/dispatch/skills/autopilot/scripts/usage-attribute.test.ts` (new) — the unit tests
- `packages/dispatch/skills/autopilot/scripts/fleet.ts` (modify) — **exactly two edits**: add the optional `usage` field to the `FleetRow` type, and put `export` in front of the existing `fleetIdentity` function so it can be reused rather than copied. Change nothing else in that file.

## Implementation notes

### The entry point

```ts
import type { AgentUsage, TokenCounts, UsageRollup } from "./usage-types";
import type { FleetRow } from "./fleet";

/**
 * Attach per-agent usage to fleet rows and roll the whole set up.
 * Returns new row objects; never mutates the input.
 */
export function attributeUsage(
  rows: FleetRow[],
  agents: AgentUsage[],
): { rows: FleetRow[]; rollup: UsageRollup };
```

**Purity is part of the contract, not a style note.** Build new row objects with
`{ ...row, usage }`. Never assign onto an input row, never sort an input array in
place — `Array.prototype.sort` mutates, so copy before sorting. One acceptance
criterion tests exactly this by deep-freezing the inputs.

The module imports types only from `./usage-types` and `./fleet`. It reads no files,
calls no `Date.now()`, and takes no configuration.

### Reusing the identity helper

`fleet.ts` already owns the one place a fleet identity string is built:

```ts
export function fleetIdentity(
  task: string,
  role: string,
  attempt: number | undefined,
): string {
  return `${task}|${role}|${attempt ?? "-"}`;
}
```

Add the `export` keyword to that existing declaration and import it. Do not write a
second copy — two implementations of one key format drift the moment either side
changes, and the failure is a silently empty pairing rather than an error.

### Building the identity for a fleet row

A `FleetRow` does not carry its identity string, so rebuild it:

```ts
fleetIdentity(row.ref ?? "", row.role, row.attempt)
```

`row.ref` is safe to use as the task ref. The aggregator sets it as
`parsed.ref ?? entry.task`, so even a label shape that carries no ref of its own — the
review-lens form, which parses a lens instead — still falls back to the logged task.

### The two role vocabularies already agree — do not build a translation layer

It looks like the two sides of this join speak different vocabularies. They do not, and
the tempting mapping function is an abstraction with nothing to abstract.

- A fleet row's `role` is a closed enum: `scout`, `dev`, `verify`, `requalify`, `judge`,
  `review`, `fix`, `done`, `block`, `commit`, or `unknown`.
- An agent's `role` comes from the announce line's `--role`, which is the **same string**
  the flightlog note carries. Every role that actually produces a row — `verify`,
  `judge`, `dev`, `scout`, `review`, `fix` — is a member of that enum and compares
  directly.

So compare the strings as they are. Do not write a `normalizeRole` function.

One case looks like it needs mapping and does not. The finalize prompt has no role, and
the reader labels it `mark-done`. Those agents **write no flightlog entry at all**, so
they never produce a row and can never pair with one. Their tokens reach the display
only through the per-task and plan totals, which is the intended behaviour. Mapping
`mark-done` onto `done` would be worse than useless: it would make those agents eligible
to pair with an unrelated row the moment a plan ever produced one.

A `null` role belongs to no group, exactly like a `null` task.

### Grouping

- Group rows by their rebuilt identity into `Map<string, FleetRow[]>`.
- Group agents by `fleetIdentity(agent.task, agent.role, agent.attempt)`, using the
  parsed role string unchanged. An agent whose `task` or `role` is `null` belongs to
  **no** group — it can never be paired, but it still counts toward the rollup.

### The pairing algorithm

Within each identity group, pair rows to agents one-to-one by nearest start time.
Timestamps live on both sides: `row.startedAt` and `agent.startedAt`, both ISO strings.

1. Parse each side's timestamp once into epoch milliseconds. A missing, `null`, or
   unparseable timestamp yields `null`, not `NaN` and not `0` — a zero would read as
   1970 and win every comparison it entered.
2. Build every candidate `(row, agent)` pair in the group where **both** timestamps
   parsed, each carrying `distance = Math.abs(rowMs - agentMs)`.
3. Sort candidates ascending by `distance`; break a tie by the agent's `file` path
   compared with `localeCompare`, then by the row's `key`. The tie-break is what makes
   the function deterministic, and a test asserts that the same input produces the same
   output across repeated calls.
4. Walk the sorted candidates greedily: take a pair when its row and its agent are both
   still unpaired, then mark both as taken.
5. After the timestamped pass, pair any remaining rows to any remaining agents in the
   group in stable order — agents by `file` path, rows by `key`. This is where an entry
   with no usable timestamp lands, and only after every timestamped candidate has had
   its chance.

Greedy nearest-neighbour is deliberately not a global optimum. Say so in a comment and
name the reason: agents in one fan-out start seconds apart, so the greedy and optimal
assignments agree in every observed case, and a full assignment solver would be a
solver nobody asked for.

A row with no partner keeps `usage` **undefined**. Never write a zeroed `TokenCounts`
onto an unpaired row — the rendering layer relies on `undefined` meaning "no data" and
on zero meaning "measured zero", and collapsing the two turns an external-engine agent
into a row that claims it burned nothing.

### The rollup

```ts
{
  byTask: Record<string, TokenCounts>,  // summed over every agent naming that ref
  unattributed: TokenCounts,            // agents whose task ref could not be parsed
  totals: TokenCounts,                  // every agent, full stop
  agentCount: number,                   // how many agents were fed in
}
```

`byTask` counts an agent whether or not it paired to a row — the task total must not
depend on whether the pairing found a home for it.

**The conservation invariant**, over all four counters:

```
sum(values(byTask)) + unattributed === totals
```

Give it its own test. It is the only cheap check that a pairing bug has not eaten or
duplicated somebody's tokens.

Row-level attribution is deliberately outside this invariant. A row may end with no
usage and no total moves.

### Summing helper

Write one small exported adder rather than repeating four field names in five places:

```ts
/** Add `from` into `into`, in place. `into` is always a fresh accumulator. */
export function addCounts(into: TokenCounts, from: TokenCounts): void;
```

## Acceptance criteria

- [x] `attributeUsage(rows, agents)` returns `{ rows, rollup }` matching the frozen signature, importing its types rather than redeclaring them.
- [x] `fleetIdentity` is exported from the fleet module and imported here; no second copy of the identity format exists in the codebase.
- [x] The `FleetRow` type carries the optional `usage` field, and those two edits are the only changes made to the fleet module.
- [x] A group holding five agents and five rows pairs by nearest start time, not by array order — a case where the two orders differ proves it.
- [x] A group with more agents than rows, and a group with more rows than agents, both leave the surplus unpaired without throwing and without inventing a partner.
- [x] An unpaired row's `usage` is `undefined`, never a zeroed object.
- [x] Repeated calls on an input containing a timestamp tie return byte-identical output.
- [x] `sum(values(byTask)) + unattributed === totals` holds for all four counters on a mixed input containing paired agents, unpaired agents, and agents with a null task.
- [x] Input rows and agents are unmodified after the call, verified against deep-frozen inputs.

## Verification

- [x] Run `bun test packages/dispatch/skills/autopilot/scripts/usage-attribute.test.ts` — every test passes.
- [x] Run `bun test packages/dispatch/skills/autopilot/scripts/fleet.test.ts` — every test still passes, proving the two edits to the fleet module broke nothing.
- [x] Run `bunx --bun tsc --noEmit | grep packages/dispatch/skills/autopilot` — it prints nothing. Do **not** pass file paths to `tsc`: naming files on the command line drops the root `tsconfig.json`, so `strict` runs without Bun's global types and every `Bun`, `process`, and `Buffer` reports as an undefined name, hiding the real errors among a dozen fake ones. Do not chase a zero repo-wide total either; the repo has pre-existing errors elsewhere and is not green.
- [x] Run `git status --short -- packages/dispatch/skills/autopilot/scripts/usage-attribute.ts packages/dispatch/skills/autopilot/scripts/usage-attribute.test.ts packages/dispatch/skills/autopilot/scripts/fleet.ts` and confirm all three paths are dirty. This gate claims nothing about any path outside that list.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Pairs by array order, or the role vocabularies are never reconciled so nothing ever pairs; the conservation invariant does not hold | Nearest-time pairing works on the simple case but ties are non-deterministic, or a null timestamp sorts as epoch zero and wins comparisons | Nearest-time greedy pairing with a deterministic tie-break; null timestamps pair last; surplus on either side handled; conservation holds on all four counters |
| Test coverage | ×2 | No tests, or only a single 1:1 group | Happy path plus one edge; the invariant and the determinism claim are untested | Covers 1:1, 5×5 out-of-order, surplus in both directions, timestamp ties, null task, the invariant, both empty inputs, and non-mutation of frozen inputs |
| Interface & readability | ×1 | Reads the filesystem, calls the clock, or mutates its arguments | Pure but the pairing is one long function with the grouping, sorting, and rollup interleaved | Pure data-in / data-out; grouping, pairing, and rollup are separately named and separately testable; the identity helper is reused, not copied |
| Assumptions & docs | ×1 | The role mapping is a bare table with no explanation of why the two vocabularies differ | Assumptions made but not written down | The role-vocabulary drift, the greedy-not-optimal choice, and the undefined-versus-zero distinction each carry a one-line comment naming the reason |

## Out of scope

- **Reading anything from disk.** Deferred. Reason: this module takes data and returns data; the reader that produces `AgentUsage[]` is a separate module that is imported, never re-implemented here.
- **Changing the server-sent-event frame type or the events module.** Deferred. Reason: a later task owns the wiring, and touching that file here would collide with it.
- **Dollar cost or any pricing table.** Deferred. Reason: pricing lives in another plugin and cross-plugin imports are forbidden; whether to duplicate a price table is an open product decision.
- **Rendering, formatting, or abbreviating numbers.** Deferred. Reason: this module emits raw integers; a later task owns every display concern.
- **Capturing usage for agents run through an external engine.** Deferred. Reason: those subprocesses write no Claude transcript, so no `AgentUsage` for them ever reaches this function; their rows correctly end with `usage` undefined.
