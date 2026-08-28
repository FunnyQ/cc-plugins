---
version: 1
slug: "h-skills-autopilot-dashboard-dist-modules-graph-js"
primary_target: "packages/dispatch/skills/autopilot/dashboard/dist/modules/graph.js"
related_targets: ["packages/dispatch/skills/autopilot/dashboard/dist/style.css"]
---

# Flightdeck dependency graph — Interlocking Panel

**Scope** the Graph view of the autopilot flightdeck (`dashboard/dist/modules/graph.js` + the `.dependency-graph` block in `style.css`). **Mode** Operate.

**Audience / job** One engineer watching an autopilot run, usually at night, beside a terminal. Two questions only: what is holding this task up, and what starts moving when it lands. Third: what has it cost.

**Constraints** No build step (`dist/` committed as-is). No runtime deps. Bun + petite-vue. `modules/*.test.js` stays green. PRODUCT.md ("Hangar") is product truth: dark only, monospace, density is the point, no glassmorphism, no decorative gradients, no drop shadows, no radius above 4px, **no pill shapes**, no third accent.

## Direction

**Interlocking Panel** — a railway NX entrance-exit signalling desk. Chosen by the user over the roll's assigned "Drawing Sheet" (seed `5e8c7193`, scope direction, mode operate). Comp-led.

Approved composition: **B + C combined**, approved in conversation 2026-08-29.

- `.impeccable/mocks/comp/b-throat.png` — the resting state. Approved.
- `.impeccable/mocks/comp/c-route.png` — the hover state. Approved.

They are not alternatives; they are the same panel at rest and under focus.

## The mapping

| Signalling | Flightplan |
| --- | --- |
| running road (a named horizontal line) | bucket |
| berth segment on a road | task |
| diagonal crossover between roads | a dependency that leaves its own bucket |
| the road continuing | a dependency inside one bucket |
| signal aspect head | the gate between two tasks |
| cleared / occupied / unset / at danger | done / in-flight / ready / blocked |
| set route lit end to end | the hovered task's lineage |

Horizontal position along a road stays dependency depth, exactly as `layoutGraph` computes it now. Vertical position becomes bucket, not barycentre rank.

## Memorable moment

Hover a berth and the whole panel goes dark except one route, lit end to end from its earliest ancestor to its furthest dependent, crossovers included. The two questions get answered by one lit line instead of by tracing.

## Must not be literalized

- The comps' lower tables invent railway content (train IDs, `NORTH YARD → SOUTH JN`, `ROUTE_SET` / `SIGNAL_PROVE` event rows). That region stays the **agent fleet** exactly as it ships today. The world dresses the diagram, never the data.
- `b-throat`'s road names (`UP MAIN 1`, `GOODS LOOP`) are railway flavour. Real road labels are the bucket names.
- `c-route`'s `RD1..RD6` / `101..612` berth numbering is not adopted; refs stay `bucket/NN`.
- The comps' rounded signal-lamp housings are illustration. Radius stays ≤ 4px per PRODUCT.md.

## Inventory

Sampled from the approved comps, not estimated.

| Ingredient | Medium | Note |
| --- | --- | --- |
| roads, berths, crossovers, signal heads | authored SVG | countable elements, exact geometry — code, never raster |
| lit / unlit state ramp | CSS custom properties | see below |
| berth ref + token label | SVG text, monospace | as today |
| route lighting on hover | CSS class swap on the existing SVG | no re-layout; `paintLineage` already has the hook |
| agent fleet table | existing HTML | untouched |
| road name labels | SVG text | left and right gutters, mirrored, as in both comps |

**The lit ramp is the finding.** Comp pixels light at `#4dc74c` (b-throat) and `#0fa804` (c-route); the pinned `--state-done` is `#5fa249`. The panel does not *fill* a segment, it *lights* one. Each state therefore needs three steps on one hue — lit, base, unlit — reachable with value alone, so no gradient and no shadow is required and none is permitted. The pinned tokens stay the base step; PRODUCT.md outranks the comp on hue because the user pinned it deliberately.

Sampled grounds: `#01080d` (b-throat), `#0a0b0b` (c-route) against the pinned `--ground: #0e1114`. Keep the token.

## Unresolved

- The token pill added earlier this session violates PRODUCT.md's "no pill shapes" and "no radius above 4px". This redesign must retire it, not inherit it.
