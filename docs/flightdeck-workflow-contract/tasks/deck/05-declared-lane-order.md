# DECK-05: Honor declared lane order in the dependency graph

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/contract.md`
> - `../_context/rubric.md`
>
> **Depends on**: deck/03
> **Blocks**: skill/02
> **Status**: done

## Goal

The dependency graph draws its roads in the order the payload declares, and
draws a road for a lane that holds no node, so the author's declared road order
is what the reader sees.

## Files to create / modify

- `packages/dispatch/skills/autopilot/dashboard/dist/modules/graph.js` (modify) — take the road order as an input instead of deriving it
- `packages/dispatch/skills/autopilot/dashboard/dist/modules/graph.test.js` (modify) — cover declared order and empty roads
- `packages/dispatch/skills/autopilot/dashboard/dist/app.js` (modify) — pass the payload's bucket list through, and into the redraw key

## Why this task exists

The contract lets a workflow's author declare road order, top to bottom, and the
lanes panel already honors it. The dependency graph does not, and today it
cannot: `layoutGraph` sorts its input with `compareTaskOrder` — bucket name
alphabetically first — and then derives the road list from the order buckets
happen to appear in that sorted list. The payload's own bucket list never
reaches it, because `updateGraph` is called with the task array alone.

Two promises break as a result. A declared order that is not alphabetical is
silently re-sorted, so the panel shows a road order nobody chose. And a lane
holding no node produces no road at all, because roads are discovered from
nodes — so a stage that has not started yet vanishes rather than sitting empty
and waiting.

There is a stale comment above that loop claiming the roads arrive "in the order
`/api/tree` already sorted them into". That was true of the intent and has never
been true of the code. Fix the comment in the same edit; leaving it is worse
than having no comment, because the next reader trusts it.

## Implementation notes

### The layout input

`layoutGraph(nodes, opts)` already takes an options object. Add the road order
to it rather than to the node array — the order is a property of the run, not of
any node, and threading it through the nodes would mean re-deriving it on every
redraw.

```js
// opts gains one field. Absent or empty falls back to today's behaviour
// exactly, so a caller that does not supply it is unaffected.
layoutGraph(nodes, { lanes: ["scout", "build", "verify"], ...rest });
```

Rules for the road list, in this order:

1. When `lanes` is supplied and non-empty, it is the road order, verbatim. Do
   not sort it, do not dedupe it into a different order, and do not move a road
   because of where its nodes landed.
2. A lane in that list with no nodes still gets a road. The road draws its name
   in the gutters and its running line, and holds no berth.
3. A node whose bucket is **not** in the supplied list still gets a road,
   appended after the declared ones in first-seen order. Dropping the node would
   be worse: a node absent from the panel reads as work nobody planned rather
   than as a lane the author forgot to declare.
4. When `lanes` is absent or empty, derive the road list exactly as today.

Rule 3 matters even though the loader rejects a node whose lane is undeclared:
this module is also called by the task-tree source, which has no declared lane
list at all, and by tests.

### What must not change

`compareTaskOrder` keeps sorting the nodes. It fixes tie-breaks in depth and
slot placement, and only the _road_ order is being taken out of its hands. A
node still never leaves its own road, which is what makes a crossover mean "this
dependency changed road" rather than "the layout needed room".

Nothing about the visual language changes: no new colour, no new shape, no
change to the berth plate, the signal head, or the crossover curve. An empty
road is the existing road drawn with no berths on it, not a new kind of thing.
The panel's design contract is at the top of that module — read it, and keep
inside it.

The geometry derives the panel's height from the road count. A run declaring
lanes it has not reached yet therefore opens taller than it does today. That is
correct and intended: the reader sees the whole route from the start.

### Only the graph source supplies a road order

`app.js` must pass the payload's bucket list **only when the payload's
`deckSource` field says `"graph"`**, and pass nothing for `"tasks"`.

The field is `deckSource`, not `source` — on the server side that name was
already taken by a transcript-reader injection point, and the payload uses the
same name on both sides so the two never have to be translated. Reading
`payload.source` here finds nothing, so the road order is never passed, the
declared order is silently re-sorted, and empty roads disappear — with no error
anywhere.

This is not defensive coding. The task-tree loader lists every bucket directory,
including one holding no task files — so handing its bucket list over as a
declared lane order would grow empty roads on autopilot runs that never had
them, and change the panel's height with them. That is a visible regression in
the path this plan promises to leave untouched, and it would not be caught by a
test that only exercises `layoutGraph` with no lanes supplied, because the
regression is in what the caller passes.

Assert it at the caller: a task-tree payload whose bucket list contains a bucket
with no tasks must render the same road set it renders today.

### The redraw key

`updateGraph` memoizes on a structure key plus the pane box, so coordinates stay
frozen while polling changes only live state. The road order has to join that
key. Without it, a payload whose lane order changed would keep the previous
layout and the panel would quietly disagree with its own data.

The resize handler calls `updateGraph` with the held nodes rather than with the
payload's tasks. Whatever shape you choose for the call, both call sites must
carry the same lane list, or a resize silently re-sorts the roads back.

### Tests

Follow the existing style in that module's test file: in-memory node factories,
plain deep-equality assertions on the returned maps and arrays, no I/O.

Cover:

- a declared order that is **not** alphabetical, asserted to survive — an
  alphabetical fixture proves nothing here
- a declared lane holding no nodes, asserted to receive a road
- a node whose bucket is not declared, asserted to receive a road appended after
  the declared ones
- no lanes supplied, asserted to produce exactly today's road order
- the node ordering within a road, asserted unchanged

## Acceptance criteria

- [x] `layoutGraph` accepts a road order through its options object and uses it verbatim when non-empty.
- [x] A declared order that is not alphabetical survives to the rendered road sequence.
- [x] A declared lane with no nodes is drawn as a road with no berths.
- [x] A node whose bucket is not declared is drawn on a road appended after the declared ones, never dropped.
- [x] With no road order supplied, the layout is identical to today's, asserted by a test.
- [x] The caller supplies a road order only when the payload's `deckSource` field says the graph source, and a task-tree payload carrying an empty bucket renders today's road set — asserted at the caller, not only at the layout function.
- [x] The road order is part of the redraw key, and both call sites supply the same list.
- [x] The stale comment claiming the roads arrive pre-sorted is corrected.
- [x] No visual token, shape, or geometry constant changes.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/dashboard/dist/modules/graph.test.js` passes.
- [x] `bun test packages/dispatch/skills/autopilot/dashboard/dist/modules/` passes.
- [x] `bun test packages/dispatch/skills/autopilot/scripts/` passes — the server side is untouched and must stay so.
- [x] `bunx --bun tsc --noEmit | grep packages/dispatch` prints nothing. The repo-wide run is not green — 86 pre-existing errors sit elsewhere — so a clean result means these paths print nothing, not that the count is zero.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension               | Weight | 0–1 (fail)                                                                                                | 2–3 (below bar)                                                                                               | 4–5 (pass)                                                                                                             |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | Declared order is still re-sorted, or an undeclared node is dropped                                       | Order survives but an empty lane draws no road, or the redraw key misses it so a lane change does not repaint | All four road rules hold, empty roads draw, and no supplied order reproduces today's layout exactly                    |
| Backward compatibility  | ×2     | An existing layout assertion was changed to accommodate the new input                                     | Layout matches but an existing test was rewritten rather than added to                                        | Every existing assertion passes untouched, and the no-lanes path is proven identical to today                          |
| Test coverage           | ×2     | No test for the new input                                                                                 | Only an alphabetical declared order is asserted, which the old code also satisfies                            | A non-alphabetical order, an empty lane, an undeclared bucket, and the fallback are each asserted                      |
| Interface & readability | ×1     | The order is threaded through the node objects, or a second road-building path appears beside the old one | The option works but the four rules are unexplained where they are applied                                    | One road-building path, the option's fallback is obvious, and the corrected comment states what the code actually does |
| Assumptions & docs      | ×1     | The taller panel and the undeclared-bucket rule are left for the next reader to discover                  | The rules are implemented but the reason for keeping an undeclared bucket is unrecorded                       | Both the height consequence and the keep-don't-drop choice are recorded in one line each                               |

## Out of scope

- **Any change to the panel's visual language** — Deferred. The design contract at the top of the module governs colour, shape, and geometry; this task changes which roads exist and in what order, and nothing about how one looks.
- **Making the lanes panel honor anything new** — Deferred. It already reads the payload's bucket list in order and needs no change.
- **Server-side payload work** — Deferred. The payload already carries the declared order by the time this task starts; this task only stops the frontend from discarding it.
