# CONTRACT-01: Add the state entry kind to the flightlog

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: contract/02, contract/03, deck/02
> **Status**: done

## Goal

The flightlog schema, its parser, and its CLI accept a third entry kind —
`state` — so a workflow agent can declare a node done, blocked, or failed
without editing a file, and every existing consumer keeps behaving identically.

## Files to create / modify

- `packages/dispatch/skills/flightplan/scripts/lib/flightlog.ts` (modify) — add
  `StateEntry`, widen `FlightlogEntry`, teach `parseLines` to keep
  `kind === "state"`, keep `renderRunlog` and `renderLine` working
- `packages/dispatch/skills/flightplan/scripts/lib/flightlog.test.ts` (modify) —
  parse, format, render, and append coverage for the new kind
- `packages/dispatch/skills/flightplan/scripts/flightlog.ts` (modify) — a
  `state` subcommand beside the existing `log` and `report`
- `packages/dispatch/skills/flightplan/scripts/flightlog.test.ts` (modify) — CLI
  flag-validation coverage
- `packages/dispatch/skills/autopilot/scripts/fleet.ts` (modify) — the consumers
  that stop typechecking once the union widens
- `packages/dispatch/skills/autopilot/scripts/fleet.test.ts` (modify) — assert
  the new kind is inert in the fleet table

## Implementation notes

### The new type

Add to `lib/flightlog.ts`, beside `ScoreEntry` and `NoteEntry`:

```ts
export type StateEntry = {
  kind: "state";
  ts: string;
  /** Node ref, in the declared graph's `<lane>/<NN>` shape. */
  task: string;
  state: "done" | "blocked" | "failed";
  agentLabel?: string;
  /** One line of why. Required for `blocked` and `failed`. */
  message?: string;
};

export type FlightlogEntry = ScoreEntry | NoteEntry | StateEntry;
```

Note what it deliberately lacks: no `role` and no `attempt`. A `state` entry is
a declaration about a node, not a record of an agent's turn. Those two absences
are what break the consumers below, and that is the point — the compiler names
every place that was assuming every entry describes an agent.

Update the module's own header comment: it opens by saying "Two kinds of entry
land in one JSONL file" and enumerates them. Three do now.

### The pure builder

Follow the split the module already documents — pure functions take `ts`
already set so they stay deterministic under test; only the CLI stamps the wall
clock. `buildNoteEntry` in `scripts/flightlog.ts` is the shape to mirror:

```ts
export function buildStateEntry(meta: {
  task: string;
  state: "done" | "blocked" | "failed";
  ts: string;
  agentLabel?: string;
  message?: string;
}): StateEntry;
```

Put it beside `buildNoteEntry` in `scripts/flightlog.ts`, not in the lib — that
is where `buildNoteEntry` lives, and splitting the two builders across files
would leave no rule for where the third goes.

### The parse rule

`parseLines` today keeps a line only when `kind` is `"score"` or `"note"`:

```ts
if (parsed && (parsed.kind === "score" || parsed.kind === "note")) {
```

It gains `"state"` and still drops everything else silently. State that
asymmetry in a comment, because it is the two-way back-compat guarantee: a new
trail read by an older flightdeck loses its state lines and degrades to the
note-derived picture, and a future fourth kind read by this parser does the
same. Neither throws, and neither poisons the rest of the file.

Do not add validation to `parseLines`. A line whose `state` value is outside
the known set is still parsed and kept — the reader that resolves node state
decides what an unknown value means, and the parser's tolerance contract is
"drop only what is unparseable or foreign".

### The CLI subcommand

```bash
bun flightlog.ts state <logfile> --task <ref> --state done|blocked|failed \
  [--agent "<label>"] [--message "<why>"]
```

Rules, mirroring how `log` already validates:

- `--task` and `--state` are required; a missing one exits `2` with a message
  naming what was missing.
- `--state` must be one of the three values; anything else exits `2`.
- `--message` is **required** when `--state` is `blocked` or `failed`. A blocked
  node with no reason is unactionable on the panel. It stays optional for
  `done`.
- Read `--message` with `flagValue(rest, "--message", { allowDashValue: true })`
  — free text may legitimately open with `--`, which is why `log` already passes
  that option.
- Update the `usage()` text and the module header's `Usage:` block. Both
  enumerate the subcommands, and a third one that appears in neither is
  undiscoverable.

### The back-compat work — the heart of this task

Widening the union breaks every consumer that reaches for `role`, `attempt`,
`phase`, or `message` without narrowing first. TypeScript surfaces them. Handle
each deliberately; do not silence one with a cast or a non-null assertion.

**`lib/flightlog.ts` — `renderLine`.** Its first line reads `e.attempt` before
any narrowing, and `StateEntry` has none. Narrow first. Decide what a `state`
entry renders as and write the decision down: a single line naming the node's
declared state plus its message is enough, and it must not disturb the
`renderRunlog` grouping (group by `task`, first-seen order, `phase: "start"`
notes dropped). The existing `renderRunlog` filter already narrows on
`e.kind === "note"` and needs no change.

**`fleet.ts` — `aggregateByTask`.** Two problems, both silent if missed:

- `aggregate.attempts = Math.max(aggregate.attempts, entry.attempt ?? 0)` runs
  before the kind check. A `state` entry has no `attempt`, so `?? 0` makes it
  harmless today — but the line must still narrow, and the intent must be
  explicit: **a `state` entry never contributes to `attempts`.** Attempts count
  an agent's retries, and a declaration is not an attempt.
- The `openStarts` bookkeeping below it builds a `fleetIdentity` from
  `entry.role` and increments or decrements on `entry.phase`. A `state` entry
  must reach neither. It opens no row and closes none.

The cleanest shape is an early `continue` for `kind === "state"` at the top of
the loop, before the `attempts` line — but the entry must still create the
task's aggregate if none exists yet, or a node whose only trail entry is a
`state` line would vanish from the by-task map. Decide, and comment the choice.

**`fleet.ts` — `roleFromEntry`.** It falls through to `entry.role` for anything
that is not a score. A `state` entry has no role. It must return before that
line; `"unknown"` is the honest answer, and it does not matter much because of
the next point.

**`fleet.ts` — `aggregateFleet`.** A `state` entry produces **no `FleetRow`**.
It is not an agent's life cycle, and a synthetic row for it would appear in the
fleet table as a phantom agent that never ran. The identity construction, the
`phase === "start"` open, the close-matching, and the orphan-`end` fallback all
sit inside this function and all assume note-or-score. Skip `state` entries at
the top of the loop.

Leave `waves.ts` alone. It reads only `entry.agentLabel`, which `StateEntry`
carries.

### Tests

Follow the conventions in the shared context — `bun:test`, relative imports,
in-memory fixtures for the pure functions, a real temp dir for anything that
touches the filesystem.

Worth asserting specifically, because each one is a silent failure if wrong:

- A `state` line round-trips through `formatEntry` and `parseLog`.
- A line with an unrecognised `kind` is still dropped.
- A `state` line whose `state` value is outside the known set is still **kept**
  by the parser.
- `aggregateFleet` over a trail containing `state` entries returns the same rows
  as the same trail with them removed.
- `aggregateByTask`'s `attempts` is unchanged by interleaved `state` entries.
- `renderRunlog` output for a trail of notes and scores is byte-identical to
  what it produced before this change.

## Acceptance criteria

- [x] `StateEntry` exists with exactly the fields above, and `FlightlogEntry` is
      the three-way union.
- [x] `parseLines` keeps `state` lines, still drops unknown kinds, and still
      drops malformed JSON without aborting the rest of the file.
- [x] `buildStateEntry` is pure and takes `ts` from its caller.
- [x] The `state` subcommand rejects a missing `--task`, a missing or invalid
      `--state`, and a missing `--message` when the state is `blocked` or
      `failed`, exiting `2` in each case.
- [x] `aggregateFleet` produces no row for a `state` entry, and `attempts` in
      the by-task rollup is unaffected by them.
- [x] `renderRunlog` handles a trail containing `state` entries and its output
      for note-and-score trails is unchanged.
- [x] No consumer was fixed with a type cast or a non-null assertion.

## Verification

- [x] `bun test packages/dispatch/skills/flightplan/scripts/` passes.
- [x] `bun test packages/dispatch/skills/autopilot/scripts/` passes — the whole
      autopilot suite, unmodified except for the additions above.
- [x] `bunx --bun tsc --noEmit | grep packages/dispatch` prints nothing. Run the
      typecheck against the root `tsconfig.json` with no file arguments; naming
      files drops the config and fabricates errors. The repo-wide run is not
      green — 86 pre-existing errors sit outside these paths — so a zero total
      is not the bar, an empty `grep` is.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                | 2–3 (below bar)                                                                                                              | 4–5 (pass)                                                                                                                                          |
| ----------------------- | ------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | The union or the parse rule is wrong, or the CLI accepts an invalid state | The happy path works but a required-flag rule is missing, or an unknown state value is dropped by the parser instead of kept | Type, parser, and CLI all match the spec, including the `--message` rule and the keep-unknown-state-value behaviour                                 |
| Backward compatibility  | ×2     | An existing test fails, or a consumer was silenced with a cast            | Consumers compile but a `state` entry leaks into the fleet table or moves `attempts`                                         | Every consumer narrows deliberately, the autopilot suite passes untouched, and note-and-score render output is byte-identical                       |
| Test coverage           | ×2     | No tests for the new kind                                                 | Round-trip only; the consumer-inertness cases are unasserted                                                                 | Round-trip, unknown-kind drop, unknown-state-value keep, CLI flag rejections, and fleet/attempts inertness all asserted                             |
| Interface & readability | ×1     | The builder is impure or lives apart from its sibling                     | Works, but the parse-rule asymmetry and the `state`-is-not-an-attempt decision are uncommented                               | Builder mirrors the existing one, the two-way back-compat guarantee is stated in one comment, the module header lists three kinds                   |
| Assumptions & docs      | ×1     | The CLI usage text and module header still describe two subcommands       | Header updated but the aggregate-creation choice is undocumented                                                             | Usage text, module header, and the one genuinely ambiguous choice — whether a lone `state` entry creates a by-task aggregate — are all written down |

## Out of scope

- **Teaching flightdeck to derive node state from these entries** — Deferred. A
  later task in the deck bucket owns the resolution rule; this task only makes
  the entry expressible, writable, and inert everywhere it already flows.
- **Any change to the graph declaration file or its loader** — Deferred. That
  file does not exist yet and nothing here reads it.
- **Making autopilot emit `state` entries** — Deferred. Autopilot derives
  completion from its task files' `Status:` line and is explicitly not being
  migrated; adding a second source of truth to it would be a regression, not a
  feature.
