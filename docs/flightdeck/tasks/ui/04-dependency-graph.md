# UI-04: SVG dependency graph

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/data-model.md`
> - `../_context/hangar.md`
> - `../_context/rubric.md`
>
> **Depends on**: ui/02, ui/03
> **Blocks**: wiring/03
> **Status**: done

## Goal

A second view for the top half of the page: the task tree drawn as a layered dependency graph in
hand-laid SVG, tinted by live state, with no charting library.

## Files to create / modify

- `packages/dispatch/skills/autopilot/dashboard/dist/modules/graph.js` (new) — layout and rendering.
- `packages/dispatch/skills/autopilot/dashboard/dist/app.js` (modify) — wire the existing header toggle.
- `packages/dispatch/skills/autopilot/dashboard/dist/style.css` (modify) — graph rules.

The dependency on the fleet task is a **write-set** one, not a logical one: both tasks edit `app.js` and
`style.css`, so running them concurrently would clobber one another. This task runs last in its bucket.

## Implementation notes

No library. Mermaid was considered and rejected: it re-parses and re-lays-out on every render, so a
graph that recolours as a run progresses would jump under the reader. Hand-laid SVG keeps positions
fixed while state changes, which is the whole point of a live view.

### Layout

Layer by longest path from a root, so an edge always points forward:

1. A node with no dependencies inside this tree is at depth 0.
2. Every other node's depth is one more than the greatest depth among its dependencies.
3. Within a depth, order nodes by bucket then by their two-digit sequence, so the arrangement is stable
   across renders.

Compute depth iteratively rather than by recursion, and guard against a dependency cycle: cap the number
of passes at the node count and, if depths have not settled, place the unsettled nodes in a final layer
and mark them. A cycle is a real possibility in a hand-edited tree, and an infinite loop in the browser
is a much worse outcome than an ugly graph.

Depth becomes the vertical axis and position within a depth the horizontal one — a tree usually has more
buckets than layers, so this reads better than the reverse.

Keep the layout a pure function so it can be reasoned about and re-run only when the task set changes:

```js
// nodes: [{ ref, bucket, nn, dependsOn: [...] }] → { positions: Map<ref, {x, y}>, layers, cyclic: [refs] }
export function layoutGraph(nodes, opts)
```

### Rendering

Nodes are rectangles, not circles — they hold a ref in monospace, and the design system's radius ceiling
is 4px, so a rounded rectangle is the only correct shape. Fill and border follow the state colours, the
same mapping the lane cards use, so the two views never disagree about what a colour means.

Edges are straight lines or simple orthogonal elbows. No bezier curves, no arrowhead markers larger than
the text. Draw every edge from the dependency list, not only the primary parent, so a task with several
upstream dependencies shows all of them.

Dim an edge whose upstream task is not yet done. The graph should make it obvious at a glance which
paths are still gated.

Size the SVG viewBox to the computed extent and let it scale to fit the container width. Do not add pan
or zoom in v1.

### Live updates

Recolour on the same polled tree payload that drives the lanes. Recompute the layout **only** when the
set of refs or edges changes, not on every poll — a state-only change must never move a node. That is
the property that makes this better than a redrawn Mermaid diagram, and it is worth testing directly:
poll twice with a changed status and confirm every position is identical.

Nodes marked cyclic render in the alert colour with a visible note naming them. A cycle means the tree
is malformed and the reader needs to know, not be shown a plausible-looking graph.

### Toggle

The header toggle already exists from the shell work. Switching between lanes and graph replaces the
content of the top section only; the fleet table below is untouched and its stream is not interrupted.

## Acceptance criteria

- [x] The header toggle switches the top section between lanes and graph without disturbing the fleet.
- [x] Node depth equals one more than the greatest depth among its dependencies.
- [x] Nodes within a layer are ordered by bucket then sequence, stably across renders.
- [x] Every dependency edge is drawn, not only a primary parent.
- [x] An edge whose upstream task is not done renders dimmed.
- [x] Node fill and border use the same state colours as the lane cards.
- [x] A state-only change recolours nodes without moving any of them.
- [x] A dependency cycle is detected, does not hang, and is rendered in the alert colour with a note.
- [x] The SVG scales to the container and the page body gains no horizontal scrollbar.
- [x] No file is added to `vendor/`.

## Verification

- [x] `layoutGraph` has unit-style checks runnable in isolation: a linear chain, a diamond, a
      disconnected pair, and a two-node cycle. Confirm the cycle case returns rather than hanging.
- [x] Start against a real tree with cross-bucket dependencies:
      `bun packages/dispatch/skills/autopilot/scripts/flightdeck.ts --plan "$(git rev-parse --show-toplevel)/docs/waypoints-skill"`
      then switch to the graph view and confirm the layering matches that tree's declared dependencies.
- [x] Start against this plan's own tree and confirm all **three** dependency-free tasks sit together at
      depth 0, and that the final-review node sits alone in the deepest layer. Three is the expected
      count; approving a layout that shows two would mean a foundation node was misplaced.
- [x] Copy a tree to a scratch directory, flip one task's `Status` from `todo` to `done`, and confirm on
      the next poll that colours change and no node moves. Capture positions before and after to check.
- [x] Copy a tree and edit two tasks to depend on each other; confirm the page stays responsive and both
      nodes are marked.
- [x] Confirm the vendor directory still holds one file:
      `ls packages/dispatch/skills/autopilot/dashboard/dist/vendor/` → `petite-vue.es.js` only.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | Hangs on a cycle, or nodes move on a state-only change | Lays out correctly but draws only primary-parent edges, or ordering is unstable | Correct layering, all edges drawn, stable ordering, cycle-safe, positions frozen across state changes |
| Design fidelity | ×2 | Adds a library, or invents colours and shapes | Uses tokens but shapes or edge weight drift from the system | Rectangles within the radius ceiling, state colours matching the lane cards, no vendor addition |
| Test coverage | ×2 | No checks on the layout function | Ran the app once | Chain, diamond, disconnected, and cycle cases checked, plus the positions-unchanged check |
| Interface & readability | ×1 | Layout math inlined in the render path | Extracted but impure | `layoutGraph` pure and separately callable, render reads its output |
| Assumptions & docs | ×1 | The cycle guard is unexplained | Present but unexplained | Comments explain the pass cap and why layout is recomputed only on structural change |

## Out of scope

- Pan, zoom, and drag. Deferred: a plan tree is small enough to fit, and interaction would compete with
  the fleet table for attention.
- Edge-crossing minimisation. Deferred: a plan's edges are few, and a proper algorithm is far more code
  than the readability it buys here.
- Mermaid, or any graph library. Rejected in the interview: relayout on every state change makes a live
  view jump.
- Rendering agent activity on the graph. The fleet table below already owns that.
