# DECK-03: Auto-detect the source and route both APIs to it

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: deck/01, deck/02
> **Blocks**: deck/04, deck/05, skill/02
> **Status**: done

## Goal

Pointing the dashboard's `--plan` at a directory holding `graph.json` serves the
same two APIs a task-tree directory serves — no new flag, no second entry point.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/graph-source.ts` (modify) — add the source detector and the payload assembly for the graph source
- `packages/dispatch/skills/autopilot/scripts/launch.ts` (modify) — widen `validatePlanDir` to accept either shape
- `packages/dispatch/skills/autopilot/scripts/launch.test.ts` (modify) — cover the widened validation
- `packages/dispatch/skills/autopilot/scripts/flightdeck.ts` (modify) — route the tree endpoint to whichever source was detected
- `packages/dispatch/skills/autopilot/scripts/flightdeck.test.ts` (modify) — serve both source shapes end to end
- `packages/dispatch/skills/autopilot/scripts/events-api.ts` (modify) — widen the events handler's options type only, so the new value can be passed; consuming it is not this task's work
- `packages/dispatch/skills/autopilot/scripts/tree-api.ts` (modify) — make the payload builder's bucket sort conditional on the source
- `packages/dispatch/skills/autopilot/scripts/tree-api.test.ts` (modify) — cover both sorting directions

## Implementation notes

### One detector, three callers

The launcher, the server's argument parser, and `createServer` each run the
directory check independently today. Widening the rule in three places is three
places for it to drift, so the rule moves into one exported function and all
three call it.

```ts
export type DeckSource =
  { kind: "tasks" } | { kind: "graph" } | { kind: "none" };

/** Impure: looks for a `tasks/` directory, then a `graph.json` file. */
export function detectSource(planDir: string): DeckSource;
```

**Precedence: the task directory wins when both are present.** A directory
holding both is far more likely an existing plan someone dropped a file into
than a deliberate hybrid, and the existing path is the one carrying the
behave-identically guarantee.

`detectSource` answers only about contents. Whether the path is a directory at
all, and whether it exists, stay where they already are — `validatePlanDir`
checks those first and its two current messages are unchanged:

```
--plan must be a directory
--plan directory does not exist
```

### The widened validation

`validatePlanDir` keeps its signature:

```ts
export function validatePlanDir(
  planDir: string,
): { ok: true } | { ok: false; message: string };
```

Only its third check changes. Today it tests for a `tasks/` directory and
reports:

```
--plan must contain a tasks/ directory
```

That message names one of the two accepted shapes. Someone pointing at a
half-written contract directory is told something is missing but not what would
satisfy it. The replacement fires when `detectSource` returns the none case and
names both:

```
--plan must contain a tasks/ directory or a graph.json file
```

`createServer` throws its own near-duplicate of that sentence before binding —
`plan must be absolute and contain a tasks/ directory`. Update it in the same
edit; a server that accepts a directory the launcher rejected, or the reverse,
is the exact drift the single detector exists to prevent.

### Routing

The tree endpoint branches on the detected source. The events endpoint does
**not** branch at all — the trail lives at the same path under both shapes
(`<plan>/.flightlog/run.jsonl`, from `runLogPath(plan)`), so its existing call
is already correct for the new source:

```ts
if (url.pathname === "/api/events") {
  return eventsHandler(request, runLogPath(plan), plan, { projectsRoot });
}
```

Leave that line alone as far as the **log path** goes. It is why this task is
small.

One thing does have to reach it, though. Both usage sources the events handler
constructs — the Claude transcript reader and the external-engine reader — are
gated on a repo root found by walking up from the plan directory for a git
directory. A run directory outside any repository makes that walk return
nothing, and both readers then silently produce zeroes. The declared repo root
from the loaded graph is the fix, and it has to be threaded through this call
site as an option alongside `projectsRoot`, not passed only to the transcript
reader — otherwise external-engine spend stays lost while Claude spend is
found, which reads on the panel as a workflow that used no external engine.

**This task must widen the options type as well as pass the value.** The two
cannot be split across tasks: TypeScript rejects an object literal carrying a
property the parameter's type does not declare, so passing the new option before
the type accepts it fails the typecheck this task's own verification runs. Add
the optional field to the handler's options type here — declaration only, left
unread — and leave the behaviour that consumes it to the task that follows.

Pass `undefined` for the task-tree source, so that path keeps walking up exactly
as it does today.

The health endpoint is untouched. It reports `{flightdeck, pid, plan}`
and the launcher's identity check reads exactly those three fields.

### Assembling the payload for the graph source

`buildTreePayload` is pure and stays pure. It already accepts everything the
graph source needs, so this is wiring, not a rewrite. Produce its input from the
loaded graph and the trail:

| Field        | Value for the graph source                                                  |
| ------------ | --------------------------------------------------------------------------- |
| `slug`       | the plan directory's base name                                              |
| `planTitle`  | the graph's declared title, falling back to the slug                        |
| `repo`       | derived from the graph's declared repo root                                 |
| `bucketDirs` | the graph's lanes, **in declared order**                                    |
| the node map | the graph's nodes, after the trail's state declarations have been folded in |
| `entries`    | the parsed trail entries                                                    |

Reuse the existing readers rather than re-implementing them: the trail is read
by the same reader the task-tree path uses, and the nodes arrive already
narrowed and already state-resolved from the loader this task builds on.

### The trap: lane order is data, bucket order is not

`buildTreePayload` sorts the bucket list before putting it on the payload. For a
task tree that is right — directory listing order carries no meaning, and
sorting makes the panel deterministic.

For the graph source the lane order **is** meaning. It is the road order the
author declared, top to bottom, and the lanes panel and the dependency graph
both lay roads out in the order the payload hands them over. Passing declared
lanes through a sort silently reorders the reader's panel with no error and no
symptom other than looking wrong.

### The payload says which source produced it

Add one field to the payload, and the same field to the events handler's
options:

```ts
deckSource: "tasks" | "graph";
```

**Call it `deckSource`, not `source`.** The events handler's options already
declare `source?: TranscriptSource` for injecting a reader in tests, and that
injection point stays exactly as it is. Reusing the name does not merely read
badly — it fails the typecheck.

Detection already runs once in this task. This field carries its answer forward
so nothing downstream has to re-derive it — and re-deriving it is the trap. Two
later behaviours branch on the source, and both would otherwise be inferred from
whether some file happens to exist: whether the panel treats the bucket list as
a declared road order, and whether a run-id membership check applies. Inferring
either from file presence makes a task tree that happens to hold an extra file,
or a contract run that happens to be missing one, take the wrong branch silently.

Set it from the detector's result. Do not compute it twice.

### The bucket sort

The sort is not in this task's new code. It lives in the existing pure payload
builder, which does `[...bucketDirs].sort()` — so the fix is an edit to that
file, and both it and its test are in this task's file list for exactly this
reason.

**Make the sort conditional on the source; do not duplicate the builder.** Give
the builder an input that says whether its bucket list is already ordered, and
have the graph path set it. Copying the builder to get an unsorted variant is
the tempting way to stay inside a narrower file list, and it is the wrong one:
two payload builders will drift, and the frontend reads whichever one ran.

Leave a one-line comment at the sort site saying why the two sources differ.
Directory listing order carries no meaning, so the task-tree source must keep
sorting; declared lane order is the author's road order, top to bottom, so the
graph source must not. Without that comment the next reader "fixes" the
inconsistency and silently reorders every contract panel.

Test both directions: the task-tree source still sorts, and the graph source
preserves the declared order — including an order that is not alphabetical, or
the assertion proves nothing.

## Acceptance criteria

- [x] `detectSource` returns the tasks case for a directory holding only a task directory, the graph case for one holding only the contract file, and the none case for a directory holding neither.
- [x] `detectSource` returns the tasks case for a directory holding both, and a comment at the branch says why.
- [x] `validatePlanDir` accepts both shapes, and rejects the neither-shape with a message naming both the task directory and the contract file.
- [x] `validatePlanDir` still returns its existing two messages for a path that is not a directory and a path that does not exist.
- [x] `createServer` accepts a graph-source directory, and its thrown message names both accepted shapes.
- [x] The tree endpoint returns a well-formed payload for a graph-source directory: title, lanes, nodes, counts, and errors all populated from the graph and the trail.
- [x] The events endpoint responds for both source shapes, tailing the same trail path under each, with no branch on the log path.
- [x] The declared repo root is passed to the events handler as an option, and is `undefined` for the task-tree source so that path still walks up as before.
- [x] Declared lane order survives from the contract file to the payload's bucket list, unsorted, proven with an order that is not alphabetical.
- [x] The task-tree source still sorts its bucket list, proven by a test, and there is exactly one payload builder.
- [x] The payload and the events handler's options both carry the detected source as an explicit `deckSource` field, set once from the detector and never re-derived downstream, with the options' existing transcript-reader injection point untouched.
- [x] Every previously passing test in the autopilot script suite still passes, unmodified except where a new case was added.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/` passes with no failures.
- [x] `bun test packages/dispatch/skills/flightplan/scripts/` passes with no failures.
- [x] `bunx --bun tsc --noEmit | grep packages/dispatch` prints nothing. Run the typecheck against the root config, never a file list — naming files on the command line drops `types: ["bun"]` and buries real errors under fake ones. The repo-wide run is **not** green (86 pre-existing errors sit outside this plan), so a zero count is not the bar; an empty grep on these paths is.
- [x] A temp directory holding a valid contract file and a trail, served through `createServer`, answers `/api/tree` with lanes in the declared order — asserted in the test suite, not by hand.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                    | 2–3 (below bar)                                                                        | 4–5 (pass)                                                                                                                                        |
| ----------------------- | ------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | Detection misreads a shape, or a source serves a malformed payload            | Both shapes serve, but precedence is wrong or declared lane order is sorted away       | All four detection cases correct, precedence deliberate, lane order preserved end to end                                                          |
| Backward compatibility  | ×2     | An existing plan directory behaves differently, or a caller interface changed | Existing path works but a message or return shape shifted without every caller updated | An existing plan directory behaves identically; the launcher, the daemon record, and the restart path keep their current interfaces byte for byte |
| Test coverage           | ×2     | No new tests                                                                  | Detection covered, but no server stands up against the new shape                       | Detection's four cases on real temp directories, both endpoints served for both shapes, and the rejection message asserted to name both           |
| Interface & readability | ×1     | The rule is re-implemented per caller                                         | One exported detector, but callers still duplicate parts of the check                  | One detector, three callers, and the lane-order divergence carries its one-line reason at the site                                                |
| Assumptions & docs      | ×1     | The precedence choice and the sort divergence are undocumented                | One of the two is explained                                                            | Both the both-present precedence and the lane-order decision are recorded in one line each, where the next reader hits them                       |

## Out of scope

- Locating agent transcripts from the declared repo root — Deferred. The next task in this bucket owns it; token figures reading `N/A` is the expected state until it lands.
- A command that lists runs under the shared data directory — Deferred. Dropped deliberately in favour of the authoring skill printing the full command, so there is no discovery mechanism to build or test here.
- Any change under `packages/dispatch/skills/autopilot/dashboard/` — Deferred. The renderer is already data-driven and consumes the payload as-is; if a panel looks wrong, the payload is wrong, not the frontend.
- Adding a flag to select the source — Deferred. Detection is deliberate: the launcher, the daemon record, and the restart path all pass `--plan` and nothing else, and a new flag would have to thread through all three.
