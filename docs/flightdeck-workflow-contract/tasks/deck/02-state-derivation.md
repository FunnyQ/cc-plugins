# DECK-02: Derive node state from the event trail

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: contract/01, deck/01
> **Blocks**: deck/03
> **Status**: done

## Goal

The loaded graph's nodes carry the state the event trail declares, so the
dashboard's existing state ladder produces the right answer without a second
state machine being written.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/graph-source.ts` (modify) — add the mapping
- `packages/dispatch/skills/autopilot/scripts/graph-source.test.ts` (modify) — cover it

## Implementation notes

### Write a mapping, not a ladder

This is the one thing to get right. `deriveTaskViews` in
`packages/dispatch/skills/autopilot/scripts/fleet.ts` **already** resolves a
node's displayed state, from exactly two inputs on the node — its `status`
string and its `validity` — plus the open-start count it derives from the trail
itself. The contract's resolution order maps onto those two inputs one-for-one.

So this task writes a function that translates state entries into `status` and
`validity`. It does **not** write a second resolver.

Writing a parallel ladder is the failure mode here. Two ladders drift, and the
drift is invisible: both keep rendering, one of them wrongly.

The existing ladder, reproduced so you need not open it, and which **must not
be modified**:

```ts
if (validity.kind === "invalid") state = "invalid";
else if (task.status === "done") state = "done";
else if (task.status === "blocked") state = "blocked";
else if (task.status === "in-progress") state = "in-progress";
else if (task.status === "todo" && hasOpenStart(aggregate))
  state = "in-progress";
else if (task.status === "todo" && blockedBy.length === 0) state = "ready";
else state = "blocked";
```

### The signature

```ts
/**
 * Pure. Folds the trail's state declarations into the loaded nodes, leaving
 * every other field alone. Returns a new map; mutates nothing.
 */
export function applyStateEntries(
  nodes: Record<string, GraphNode>,
  entries: FlightlogEntry[],
): { nodes: Record<string, GraphNode>; errors: GraphSourceError[] };
```

Errors are returned as data and surface in the payload's `errors` array, the
same way a malformed graph file does. Nothing throws.

### The mapping

For each node, take the **latest** state entry naming it. Latest means **last
by position in the trail**, which is write order — not by timestamp. Two agents
finishing in the same second produce equal `ts` values, so a timestamp sort has
no defined winner while trail order always does.

| Latest state entry | → `status`     | → `validity`                                                 |
| ------------------ | -------------- | ------------------------------------------------------------ |
| `done`             | `"done"`       | `{kind: "complete"}`                                         |
| `blocked`          | `"blocked"`    | `{kind: "unfinished", status: "blocked"}`                    |
| `failed`           | left as loaded | `{kind: "invalid", rule: "failed", reason: <entry message>}` |
| none               | left as loaded | left as loaded                                               |

For `failed`, the entry's `message` is the reason. When it is absent, use a
stated fallback — `"agent reported failure with no message"` — rather than an
empty string, because the reason renders directly in the panel and an empty one
reads as a rendering bug.

Two cases produce an error instead of a mapping:

- **An unknown state value.** The node reads `invalid`
  (`{kind: "invalid", rule: "unknown-state", reason: ...}`) _and_ an error is
  reported. Both, not one: a value nobody recognises must not quietly leave the
  node looking ready.
- **An entry of any kind whose `task` names no node in the graph.** An error is
  reported and nothing else happens. There is no node to mark, so there is
  nothing to count as invalid either.

  **This check is not limited to state entries.** A misspelled ref on a note or
  a score loses that agent's row and its verdict just as silently as a
  misspelled state does, and a trail full of typos would otherwise render as a
  run in which nothing ever happened. So the membership check runs over every
  parsed entry, once, before the mapping — one error per distinct unknown ref,
  not one per entry, or a chatty agent drowns the panel's error list. The state
  _mapping_ still concerns state entries alone; only the check is broad.

  That last point looks like a hole in the completeness guarantee and is not.
  If every declared node is `done` and one event names a node nobody declared,
  the counts do read as fully complete — but the payload's error list is
  non-empty, and a payload carrying errors is not read as a clean run. The two
  guards cover different things and are both needed: the invalid count covers a
  declared node in a bad state, the error list covers an event that names
  nothing. Do not try to close the gap by inventing a phantom node for the
  unknown ref; a node the author never declared has no lane, no title, and no
  place on the panel.

### How each case lands in the existing ladder

This table is the whole argument for why a mapping is sufficient. The last three
rows are handled by the ladder with no help from this task at all.

| Situation                           | `status`    | `validity` | Ladder result |
| ----------------------------------- | ----------- | ---------- | ------------- |
| `done` declared                     | `"done"`    | complete   | `done`        |
| `blocked` declared                  | `"blocked"` | unfinished | `blocked`     |
| `failed` declared                   | `"todo"`    | invalid    | `invalid`     |
| unknown state value                 | `"todo"`    | invalid    | `invalid`     |
| no entry, unclosed `start` note     | `"todo"`    | unfinished | `in-progress` |
| no entry, a dependency not complete | `"todo"`    | unfinished | `blocked`     |
| no entry, nothing unmet             | `"todo"`    | unfinished | `ready`       |

### Trap: `null` is not `"todo"`

The loader produces `status: null` for a node the trail has said nothing about.
Read the ladder above again with `null` substituted: it matches none of `"done"`,
`"blocked"`, `"in-progress"`, or `"todo"`, so it falls all the way through to the
final `else state = "blocked"`. **Every unstarted node would read blocked**, and
the panel would show a run that cannot start.

Two ways to make the halves agree. Pick one deliberately and record which, in a
one-line comment at the mapping:

1. **The mapping normalises an unstarted node's `status` to `"todo"`.**
   Recommended. It keeps the shared ladder untouched, which is what the
   backward-compatibility dimension scores, and it confines the whole question
   to this one function.
2. **The ladder's `"todo"` branches widen to accept `null`.** This changes
   shared behaviour and must then be proven not to move the task-file path's
   output.

Either way, the contract's description of the loader's own output is unchanged —
it emits `null`, and normalising afterwards is precisely what this function is
for.

### Trap: state entries must not pollute the open-start count

`aggregateByTask` in the same file branches on `entry.kind === "score"` and
treats **everything else as a note**. It then reads `entry.role` and
`entry.phase`, and:

```ts
if (entry.phase === "start") aggregate.openStarts.set(identity, open + 1);
else if (open > 0) aggregate.openStarts.set(identity, open - 1);
```

A state entry has no `phase`, so it takes the `else` branch and **decrements an
open start count**. A node with an agent still in flight that also logs a state
entry would stop reading `in-progress` — one real agent's start silently
cancelled by an unrelated line.

Confirm state entries are excluded from open-start counting before this task is
done, wherever the exclusion belongs. The row in the table above claiming "no
entry, unclosed `start` note → in-progress" is false until they are.

### Ordering

The mapping runs after the graph loads and before the payload is built. It never
runs on the task-file path — that path's state comes from the task files' own
`Status` lines and `taskValidity`, and this task does not touch it.

### Naming refs in the fixtures

Give your test fixtures hyphenated lane names — `build-step/01` rather than a
single unhyphenated word before the slash. Both are valid refs under the
contract, which permits hyphens in the lane token, but only the hyphenated form
is safe to quote back into a task file or a spec: the task-file linter scans for
sibling-task-shaped strings and its own bucket token disallows hyphens, so a
hyphenated lane reads as prose to it. Using that form in the tests keeps the
examples copyable into documentation later.

### Tests

Pure, in-memory fixtures via a small local factory — no disk, no committed
fixture files. Cover:

- each of the three known state values
- last-write-wins, with two entries for one node in trail order, and with equal
  `ts` values so the test would fail under a timestamp sort
- an unknown state value: node reads invalid **and** an error is reported
- an entry naming a node absent from the graph: error reported, no node changed
- a node with no entries at all: returned unchanged apart from the recorded
  status normalization, if the decision below is the one that introduces it
- the `null`-versus-`"todo"` decision, asserted **through the derived view**
  rather than only the mapping's output, so the two halves are proven to agree
- a node with an unclosed `start` note and no state entry, asserted through the
  derived view, which is what catches the open-start pollution above

Assert with `toEqual` on whole returned objects where practical, so a new field
cannot slip through unasserted.

## Acceptance criteria

- [x] `applyStateEntries` is exported, pure, and mutates neither argument.
- [x] `done`, `blocked`, and `failed` each map to the `status` and `validity` in the mapping table.
- [x] The latest entry by trail position wins, including when two entries share a `ts`.
- [x] An unknown state value marks the node invalid and reports an error.
- [x] An entry naming an unknown node reports an error and changes no node, and
      this holds for all three entry kinds, not only state entries.
- [x] Several entries sharing one unknown ref produce one error, not one each.
- [x] A node with no state entry is returned unchanged apart from the `status` normalisation the recorded decision calls for.
- [x] State entries do not decrement the open-start count, and a node with an unclosed `start` note and no state entry reads `in-progress`.
- [x] A small graph plus a small trail produces all five displayed states — `done`, `in-progress`, `ready`, `blocked`, `invalid` — through the existing derivation.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/graph-source.test.ts` passes.
- [x] `bun test packages/dispatch/skills/autopilot/scripts/` passes — the whole autopilot suite, proving the task-file path is unmoved.
- [x] `bunx --bun tsc --noEmit | grep packages/dispatch` prints nothing. Run it against the root `tsconfig.json`, never a file list. The repo-wide run is **not** green — 86 pre-existing errors sit elsewhere — so a clean result is an empty grep, not a zero count.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                     | 2–3 (below bar)                                                                                                                      | 4–5 (pass)                                                                                                                   |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | A second state ladder was written, or the mapping produces a state the table does not call for | The three known values map correctly but an error case throws, last-write-wins is timestamp-ordered, or the `null` trap is unhandled | Every row of the mapping table holds, both error cases return data, trail order decides, and the open-start count is clean   |
| Backward compatibility  | ×2     | The shared state ladder's behaviour changed, or the autopilot suite fails                      | The ladder was widened without proving the task-file path's output is identical                                                      | The ladder is untouched in behaviour, the autopilot suite passes unchanged, and the task-file path produces identical output |
| Test coverage           | ×2     | No test, or tests that pass with the mapping deleted                                           | Happy path only — the three known values, no error cases, no equal-`ts` case                                                         | Every listed case covered, including the two asserted through the derived view rather than the mapping's output              |
| Interface & readability | ×1     | Impure, mutates its input, or smuggles I/O into a pure function                                | Works but the mapping is buried in a loop with no comment saying why it is a mapping and not a ladder                                | One pure function, clear types, and a comment recording the `null` decision                                                  |
| Assumptions & docs      | ×1     | The `null` decision is unrecorded, or the `failed` fallback string is an unexplained literal   | The decision is made but the reason is not written down                                                                              | Both traps are recorded in one line each, at the code that depends on them                                                   |

## Out of scope

- **Serving the result over HTTP** — Deferred to a later task in this bucket. This task ends at a function returning mapped nodes; nothing routes it yet.
- **Changing the state ladder's rules** — Deferred, and in fact forbidden here. The ladder is shared with the task-file path, and moving it would change a stable, heavily tested consumer. If you believe the ladder itself is wrong, record it rather than acting on it.
- **Deriving node state from score entries** — Deferred. Scores already have their own handling in the existing derivation, which attaches the latest verdict per node; only state entries drive the mapping here. Their `task` is still checked for membership, like every other entry's.
- **Reacting to a note's content beyond its existing open-start counting** — Deferred. A note's `message` and `role` are the fleet table's concern, not the graph's. Its `task` is still checked for membership.
