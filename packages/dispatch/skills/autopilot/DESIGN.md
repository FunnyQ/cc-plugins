---
name: Hangar
description: A dark ground-control desk for watching an autopilot run — a railway signalling panel above, a dispatch manifest below, state carried by value on one hue rather than by fill.
colors:
  # Ground and surfaces — the work area and its operational regions
  ground: "#0e1114"
  surface: "#171b20"
  surface-2: "#1e242b"
  rule: "#262c33"
  # Ink — the reading hierarchy
  text: "#d2d8df"
  muted: "#7c8794"
  faint: "#4c555f"
  # State — pinned, and the base step of every ramp
  state-done: "#5fa249"
  state-flight: "#c3843f"
  state-ready: "#4e97a1"
  state-blocked: "#4f5b69"
  state-alert: "#fa6b66"
  # The lit steps — the interlocking panel only, mixed toward white in oklab
  lit-done: "color-mix(in oklab, #5fa249 78%, white)"
  lit-flight: "color-mix(in oklab, #c3843f 78%, white)"
  lit-ready: "color-mix(in oklab, #4e97a1 70%, white)"
  lit-alert: "color-mix(in oklab, #fa6b66 72%, white)"
  # The unlit steps — mixed toward the ground, not toward white
  unlit: "color-mix(in oklab, #4f5b69 45%, #0e1114)"
  unlit-berth: "color-mix(in oklab, #4f5b69 75%, #0e1114)"
  crossover-cleared: "color-mix(in oklab, #5fa249 50%, #0e1114)"
  lamp-dark: "color-mix(in oklab, #4f5b69 30%, #0e1114)"
typography:
  figure:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Menlo, Consolas, monospace"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1
    fontFeature: "tabular-nums"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  data:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.2
    fontFeature: "tabular-nums"
  reading:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.2
  label:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0.02em"
  panel-ref:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Menlo, Consolas, monospace"
    fontSize: "11.9px"
    fontWeight: 600
  panel-token:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Menlo, Consolas, monospace"
    fontSize: "10.5px"
    fontWeight: 700
    letterSpacing: "0.03em"
  panel-road:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Menlo, Consolas, monospace"
    fontSize: "11.2px"
    fontWeight: 400
    letterSpacing: "0.06em"
rounded:
  sm: "2px"
  md: "4px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
components:
  deck-header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    padding: "8px 16px"
    height: "64px"
    note: "sticky; 1px rule border-block-end doubled by a zero-blur box-shadow of the same colour"
  header-state:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.muted}"
    padding: "8px 16px"
  view-toggle-button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    typography: "{typography.data}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  view-toggle-button-pressed:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  task-lane:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
  task-lane-heading:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    typography: "{typography.data}"
    padding: "8px 12px"
  task-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "12px"
  task-card-hover:
    backgroundColor: "{colors.surface-2}"
  badge:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
    note: "1px border of currentColor; the state class recolours text and border together"
  fleet-columns:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    padding: "8px 12px"
  fleet-row:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.data}"
    padding: "8px 12px"
  status-dot:
    backgroundColor: "{colors.state-flight}"
    rounded: "{rounded.sm}"
    size: "4px"
  graph-rail:
    backgroundColor: "{colors.unlit}"
    height: "11.9px"
    note: "SVG line, butt caps, full pane width; links and crossovers match it"
  graph-crossover-curve:
    note: "cubic S changing road inside one reserved gap; control points at 0.5 of the gap width, both pinned to their endpoint's y so each end leaves horizontally"
  graph-berth:
    backgroundColor: "color-mix(in oklab, {state} 22%, {colors.ground})"
    borderColor: "color-mix(in oklab, {state} 45%, {colors.ground})"
    rounded: "{rounded.sm}"
    width: "content-derived, min 98px"
    height: "26.6px"
    note: "a plate carrying its own ref and token; one shared width per panel"
  graph-berth-edge:
    backgroundColor: "{state}"
    width: "4.2px"
    note: "the lit leading edge — the plate body is a wash of the same hue"
  graph-berth-done:
    state: "{colors.lit-done}"
  graph-berth-in-progress:
    state: "{colors.lit-flight}"
  graph-berth-ready:
    state: "{colors.lit-ready}"
  graph-berth-blocked:
    state: "{colors.unlit-berth}"
  graph-berth-alert:
    state: "{colors.lit-alert}"
  graph-signal-housing:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.sm}"
    width: "17.5px"
    height: "44.8px"
    note: "1px rule stroke; three 4.76px lamps, one lit, the other two at lamp-dark"
---

# Design System: Hangar

## Overview

**Creative North Star: "The Signalling Desk"**

Hangar is one operator's desk in a dark room. The deck opens on a railway NX entrance-exit signalling panel — roads, berths, crossovers, signal heads — with a dispatch manifest of agent rows underneath it. Both halves are instruments, not pictures of instruments: the panel spreads into the pane it is given, the manifest scrolls, and nothing on either is decoration. The reader is one engineer, usually at night, beside a terminal, asking two questions about a running plan — what is holding this task up, and what starts moving when it lands — plus a third, what has it cost.

The system is **dark only, monospace by default, and dense**. There is no light branch and no theme control; the deck sits beside editors and terminals for hours and must stay visually continuous with them. Depth is a three-step ground ramp and a 1px rule, never a shadow. Colour is pinned to five states and never appears without a label, a count, or a shape beside it.

The signature move is that **state is lit, not filled**. Each state carries three steps on one hue — lit, base, unlit — separated by value alone. A signalling panel does not fill a segment, it lights one, and holding to value means the panel needs no gradient, no glow, and no shadow to say the same thing, all three of which the world forbids anyway. The rejections are specific: not a node-graph editor (free-angle wires, arrowheads, drag handles), not theatrical space (neon, glow, purple, blur), and not card-based SaaS (roomy padding, pill chips, marketing scale).

**Key Characteristics:**
- One fixed dark ground (`#0e1114`), three surfaces, one 1px rule; no light mode, no theme toggle.
- Five pinned state colours, each expanded to a lit / base / unlit ramp on its own hue by value alone.
- Monospace is the body face; the sans face is reserved for two prose slots.
- Corner radius stops at 4px, and the panel uses 2px. No pill shapes anywhere.
- The signalling panel's geometry is a multiple of one type size (`FONT_SIZE = 14`), so the whole diagram rescales from a single constant.
- Two quantities answer to the measured pane rather than to the type size: the pitch between roads and the gap between berths.
- No arrowheads, no glow, no gradient, no drop shadow, no emoji.

## Colors

Five pinned semantic colours over a near-black ground, each expanded into a three-step ramp where the interlocking panel needs to distinguish lit track from unlit.

### Primary

Hangar has no brand accent. **Flight** (`#c3843f`) is the closest thing to one because it is the only warm colour on the deck and it marks the one thing that is happening right now: an in-flight task, a live elapsed clock, a reconnecting stream, and every focus ring outside the fleet toggle.

### Secondary

- **Done** (`#5fa249`): Conclusive green. Completed tasks, the progress-ring value arc, a passed score meter, a live stream, a cleared signal aspect, and the whole of a set route's track.
- **Ready** (`#4e97a1`): Quiet available teal. Tasks whose dependencies have cleared but which nothing is working yet, rubric-dimension fills, and the fleet toggle's focus ring.
- **Blocked** (`#4f5b69`): Recedes into slate without disappearing. Tasks held up, abandoned agents, and — mixed toward the ground — every unlit thing on the panel.
- **Alert** (`#fa6b66`): Coral, reserved for failure that needs a person. Invalid tasks, hard-failed scores, rejected gates, tree errors, cycles, and the danger aspect.

### Neutral

- **Ground** (`#0e1114`): The work area, and the page. Also the mix partner for every unlit step, so unlit means "toward the ground" and lit means "toward white".
- **Surface** (`#171b20`): Operational regions — the header, lane and task cards, the fleet panel.
- **Surface-2** (`#1e242b`): The step above — lane headings, column headers, hover, meter tracks, rubric wells.
- **Rule** (`#262c33`): Structure. Every separator is a 1px rule and nothing else.
- **Text** (`#d2d8df`) / **Muted** (`#7c8794`) / **Faint** (`#4c555f`): The three-step reading hierarchy — value, caption, and metadata that should be findable but not read.

### The Lit Ramp

The panel's own tokens, defined on `.dependency-graph` and used nowhere else on the deck. The `color-mix()` expressions in the frontmatter are the source of truth; the resolved value each one renders to is given here because it is what a reader samples off the screen.

- **Lit** steps mix the pinned state toward `white` in oklab at 78% (done, flight), 70% (ready), and 72% (alert), resolving to `#82b772`, `#d19f6c`, `#85b6bd`, and `#ff9890`.
- **Unlit** (`45%` blocked in ground → `#293038`) is the rail — every road, every unset crossover, every unset running line.
- **Unlit berth** (`75%` blocked in ground → `#3d4752`) sits exactly one step above the rail, and is what a blocked plate lights its leading edge with. The two shared a value in the first build and a blocked task vanished outright, which failed the panel's whole job.
- **Cleared crossover** (`50%` done in ground → `#345430`) is a fourth resting value: a diagonal whose source task is done is already tinted green at rest, before anything is hovered.
- **Lamp dark** (`30%` blocked in ground → `#20252b`) is the two unlit lamps on every signal head. They are what makes the third one legible as an aspect rather than as a dot.

### Measured Against the Comps

Sampled from the approved comps and from the shipped 1440x900 capture, not estimated. The ship is deliberately quieter than both comps, and the reason is one rule: **PRODUCT.md's pinned hue outranks the comp, and the lit step is reached by mixing that hue toward white rather than by adopting the comp's chroma.** Taking the comp's green literally would put a near-neon at the centre of a world whose anti-goals name neon.

| | `b-throat` (rest) | `c-route` (set route) | shipped |
| --- | --- | --- | --- |
| ground | `#01080d` | `#0a0b0b` | `#0e1114` |
| lit done | `#4dc74c` | `#0fa804` | `#82b772` |
| in flight | `#ffcd03` | absent | `#d19f6c` |
| unlit track | `#6f7273` | `#414040` | `#293038` |

Two things this makes visible that neither the comps nor the shipped capture alone would. First, the comps do not agree with each other: `b-throat` rests on a near-black ground with a light `#6f7273` field and a bright `#4dc74c` lit step, while `c-route` drops the field to `#414040` and lights a darker, more saturated `#0fa804`. The shipped panel resolves the two into one ramp and reaches the focus state by opacity instead of by a second palette. Second, `c-route`'s panel contains **no amber and no red pixels at all** — under a set route the comp is literally two colours. The ship keeps state colour on the route's berths, which is the divergence recorded under The Set Route below.

### Not Sampled

The shipped capture is a completed run (15 of 15 done, 0 in flight, 0 ready, 0 blocked), so it exercises only the done path. `--lit-flight`, `--lit-ready`, `--lit-alert`, and `--unlit-berth` are computed from their `color-mix()` expressions above and are **not** confirmed against a raster. Every value that the capture can contain — `#82b772`, `#345430`, `#293038`, `#20252b`, `#0e1114`, `#171b20`, `#1e242b`, `#262c33` — was found in it at its exact value.

### Named Rules

**The Lit-Not-Filled Rule.** A state is expressed by lighting one hue to a brighter value, never by adding a gradient, a glow, or a shadow. If a new state needs marking and value is exhausted, use shape — a fill effect is not available.

**The Toward-Ground Rule.** Lit steps mix toward white; unlit steps mix toward `--ground`. An "unlit" colour that mixes toward a surface floats off the panel instead of receding into it.

**The Recede-Without-Vanishing Rule.** Blocked is the quietest state and still has to be findable, because "what is holding this up" is the question the panel exists to answer. An unlit berth's **leading edge** is always at least one value step above the rail the plate sits on. The plate body sits below the rail — that is what lets the ref inside it stay legible — so the edge is the piece carrying the rule, and it is the piece that must never be tuned down.

**The No-Third-Accent Rule.** Five state colours, and that is the whole set. A new state reuses an existing colour or is carried by shape. Purple, violet, and neon belong to the cockpit's world and must never appear here.

**The Colour-With-A-Label Rule.** Colour never travels alone. Every coloured figure on the deck carries a label, a count, or a shape — a status dot beside a number, a badge with its role text, a berth plate with its ref set inside it.

## Typography

**Body Font:** system mono (`ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace`), set on `html` at 13px.
**Prose Font:** system sans (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`).

No web fonts. There is no build step and the dashboard must work offline, so the type system is system mono plus system sans. Monospace is the default rather than the exception because the deck presents identifiers, counts, states, and machine-produced records; stable character widths make dense rows comparable down a column. The sans face appears in exactly two places — a task card's title and the fleet panel's heading — where the content is a human sentence rather than a value.

### Hierarchy

- **Figure** (mono, 400, 16px, tabular figures): The three numbers the header exists to show — the plan title, the elapsed clock, the token rollup.
- **Body** (sans, 400, 13px, line-height 1.4): Task titles and the fleet heading. The only prose on the deck.
- **Reading** (mono, 400, 13px): The document default, set on `html`.
- **Data** (mono, 400, 12px, tabular figures): Fleet rows, lane headings, view-toggle labels, token figures (at weight 600).
- **Label** (mono, 400, 11px, 0.02em, UPPERCASE): Eyebrows, definition terms, badges, column headers, connection state, counts.

The panel keeps a **second, independent scale**. Its type derives from the SVG's own `FONT_SIZE = 14` rather than from the CSS scale, because the SVG renders at natural size and every box, gap, and margin in the diagram is a multiple of that one constant: the berth ref at 0.85 (11.9px, weight 600), the token at 0.75 (10.5px, weight 700, 0.03em), the road name at 0.8 (11.2px, uppercase, 0.06em), the cycle label at 0.7 (9.8px, 0.08em).

### Named Rules

**The Mono-By-Default Rule.** Monospace is the deck's voice. The sans face is reserved for a human sentence — a task title, a panel heading — and switching to it anywhere a value is displayed breaks the column alignment that density depends on.

**The Tabular-Figure Rule.** Every figure a reader compares against another figure carries `tabular-nums`: the elapsed clock, the token rollup, every token count in the fleet and the lanes. A proportional digit in a stacked column is a misread waiting to happen.

**The One-Constant Rule.** The panel's geometry and type both derive from `FONT_SIZE = 14`. Change that one number and the whole diagram rescales in proportion; hand-tuning any individual box, gap, or label size breaks the property.

## Layout

The deck is a three-row viewport grid: header (auto), task view (`minmax(40vh, 1fr)`), fleet (`1fr`), pinned to `100vh` with the page itself not scrolling. Each half owns its own scroll. Collapsing the fleet drops its row to `auto` through `#app:has(.c-fleet.-collapsed)`, handing the height back to the panel.

The header is a six-column grid — identity, progress ring, elapsed, tokens, counts, view toggle — sticky at the top, with an error or loading strip spanning the full width beneath it when there is one.

**The panel fits the pane, in both axes.** `paneBox()` measures the graph pane's content box off the DOM and hands both numbers to `layoutGraph`. The roads spread into the measured height, capped at `fontSize * 9` so a band never grows past about twice the ink it carries; the gaps between berths compress into the measured width, floored at `fontSize * 4` — the gap is a crossover's entire horizontal reach, so below about that a change of road has no room to be a curve and reads as a kink in the rail. The gutter is sized to the longest road name's own ink rather than a flat allowance, capped at `fontSize * 9`. `layoutGraph` returns the two fitted values on `layout.geometry` and `renderGraph` reads them back, so nothing re-derives them independently and lands the signal heads where the berths are not. The plate width is the third fitted value: one shared width for the whole panel, taken from the longest ref plus a six-character token column, so the stride stays uniform and slots keep reading as columns across roads. It has no cap — a gutter is a flat allowance and can be capped without lying, but a plate that cannot fit its own ref renders a truncated task id. Past the pane the panel scrolls.

Two container queries handle the density thresholds: the lane strip drops to one full-width lane below 600px, and the fleet table scrolls horizontally below 690px. At the 899px viewport breakpoint the whole deck stops being a fixed-height grid and stacks into a scrolling page, the header collapses to two columns, and the counts wrap to a five-column row.

The 390px capture shows both rules doing their job and is the only evidence of either. The header stacks as described and the view toggle spans the full width as two large buttons. The panel does **not** reflow: it holds its geometry and runs off the right edge mid-berth, with `roadPitch` sitting exactly on its `fontSize * 9` = 126px cap and the right-hand gutter labels pushed off-screen. That is the intended answer — a berth that shrank to fit 390px would stop holding a legible `bucket/NN`, and a reader who wants the rest of the road scrolls to it.

### Named Rules

**The Measured-Pane Rule.** Layout inputs that answer to the pane are measured, never guessed from the viewport. The panel is one row of an outer grid, so its height is set by that grid, and reading it off the DOM is the only way the panel can spread into the space it was actually given.

**The Scroll-Is-Honest Rule.** Past the compression floor the pane scrolls rather than shrinking the type. The scrollbar is then the only thing telling the reader a berth exists off the right edge, so it is themed from the palette rather than left to the browser.

## Elevation & Depth

No shadows. Depth is **tonal layering** — `ground` → `surface` → `surface-2` — plus 1px `rule` hairlines and spacing. There are no bevels, no glass, no backdrop blur, and no translucent panels.

### Shadow Vocabulary

One declaration, and it is not depth: the header carries `box-shadow: 0 1px 0 var(--rule)` — zero blur, zero spread, the rule colour — which doubles its own bottom border so the sticky edge stays visible over a scrolling panel. Anything with a blur radius is forbidden.

### Named Rules

**The Tonal-Lift Rule.** To raise a surface, step the ramp. A `box-shadow` with a visible blur or offset is a regression toward card SaaS.

**The Hairline Rule.** Every separator on the deck is `1px solid var(--rule)`. There is no thick divider, no coloured left-border stripe, and no double rule.

## Shapes

Rectangles. The radius scale stops at 4px (`--radius-md`), used on lane and task cards, and 2px (`--radius-sm`) for everything smaller — berth plates, signal housings, badges, status dots, the view toggle. Nothing is a pill and nothing is a circle except the progress ring, which is a stroked arc rather than a filled disc.

The crossover's curvature is not on that scale and is not an exception to it. The scale governs the corner of a **box**, where a large radius is what turns a panel into a deck of cards; a crossover is a **line** changing direction, which is what real track does and what no card radius can express.

The panel had **exactly two angles** — horizontal and 45 degrees — through every version up to this one, on the grounds that holding to two is what lets the eye follow one line across a field of thirty others. The crossover is now a curve, and that rule is broken rather than bent. It is recorded here instead of quietly dropped because the reasoning still holds for everything else on the panel, and because what replaced it was tried the cautious way first and failed: a 45-degree diagonal with its two corners filleted is a change the eye cannot find, since any radius small enough to leave the 45 visibly straight hides inside the 11.9px stroke. What the rule still forbids is a **free-angle line between the two berths** — a bezier drawn end to end is a wire, and a panel of wires is the node-graph editor this direction refuses.

Strokes are `butt`-capped; a crossover joins its roads tangentially and no other track element has a corner to join. Every track element is drawn at exactly `fontSize * 0.85` = 11.9px, so a road, a running line, and a crossover all read as the same physical rail. The berth plate stands on that rail rather than being a length of it, and is the one panel element that does not share the weight.

### Named Rules

**The One-Curve Rule.** Every line on the panel is horizontal, except the crossover, which is a cubic S confined to one reserved gap. No free angle, and no second curved element without the same argument being made again.

**The Same-Rail Rule.** Every track element shares one stroke weight — 11.9px. A dependency drawn thinner than the road reads as an annotation about the plan rather than as part of it. The rail carried the berth's own height while a berth *was* a length of rail; the two are separate quantities now that the plate stands on it.

## Components

### The Interlocking Panel (signature)

The default view, and the deck's centre. A railway NX entrance-exit signalling desk that maps one-to-one onto the flight tree:

| Signalling | Flightplan |
| --- | --- |
| running road, named in both gutters | bucket |
| berth segment on a road | task |
| S-curve crossover through one gap | a dependency that leaves its own bucket |
| the running line inside one road | a dependency that stays in its bucket |
| three-aspect signal head | the gate at a task's entry |
| cleared / occupied / unset / at danger | done / in-flight / ready / blocked |
| one route lit end to end | the hovered task's lineage |

- **Roads** are drawn first and run the full pane width at the berth's own weight, so a berth always sits on a line that exists whether or not the plan reaches that far along it. The bucket name is set in mono uppercase at both ends, mirrored, `text-anchor: end` on the left and `start` on the right.
- **Berths** are plates 26.6px tall with a 2px radius, one shared width across the panel, positioned at dependency depth along their bucket's road. Vertical position is bucket and only bucket — a task never leaves its road, which is what makes a crossover mean "this dependency left its bucket" rather than "the layout needed the room". State is lit rather than filled: a 4.2px leading edge at the full lit value, the plate body a 22% wash of the same hue over ground, and a 45% edge stroke. A plate filled solid at the lit value would put white-on-green text at the one contrast this panel cannot afford at 2am.
- **The ref and the token ride inside the plate**, on one baseline: the ref in mono 600 set off the leading edge, the count in mono 700 muted against the trailing one. The counts then form a column down each road and can be compared without being read. They hung beneath the berth as two free lines until the plate arrived, which split every task into a coloured bar over here and an identity over there and made the reader pair the two up before a single berth could be read. The count is drawn in one ink no matter how large — a berth totals several agents, so the fleet's per-agent tiers would paint every plate on a real run — and is omitted entirely when there was no measurement. Its column is held open from the start whether or not a reading has arrived, because sizing the plate to the readings present would reflow the whole panel the first time a task reports, under a reader watching the run.
- **Signal heads** stand in the gap before any berth that has something to clear first: a 17.5 × 44.8px ground-filled housing with a 1px rule stroke, carrying three 4.76px lamps in the real top-to-bottom order (green, yellow, red), one lit and two dark. A head shorter than the plate reads as a fitting hanging off it rather than a signal standing beside it. The housing is opaque and centred on the line, so the rail passes behind it as it does behind a real backplate. The aspect follows the task's own progression — clear for done, danger for blocked or cyclic, caution otherwise.
- **Crossovers** carry only the dependencies that leave their bucket, and only the ones the transitive reduction keeps. Each changes roads inside a gap no berth occupies, chosen as early as it can, so track never crosses a berth — and the curve is held to that gap **exactly**, which is a tightening of the old guarantee rather than a relaxation of it. The 45-degree diagonal had to spend its own vertical drop in horizontal reach to hold its angle, so on a panel four roads tall it routinely overflowed the reserved gap, and more often still it could not fit between the two berths at all and fell through to a straight-line fallback. That fallback is why the panel used to draw a curve on almost none of its crossovers. A curve owes nothing to that ratio: it changes road inside one gap however far apart the two roads are.
- **A cycle** paints its members alert, labels each `CYCLE` above the plate, and prints the member refs along the bottom edge.

Three pieces of `b-throat.png`'s furniture were dropped rather than built, and the shipped capture confirms none of them returned. The comp puts a **direction arrow** at both ends of every road and a **destination label** (`TO NORTH`, `TO SIDINGS`) in the right gutter; the ship has neither, because left-to-right layout already carries direction and the right gutter earns more by mirroring the bucket name. The comp also gives each road a **leading signal head before the first berth**, which would mean a gate on a task with nothing to clear — a head stands only where a dependency does.

### The Set Route (signature interaction)

Hovering any berth adds `-focus` to the SVG and `-lit` to every element on that task's lineage — itself, everything it transitively depends on, and everything that transitively depends on it, both reached by breadth-first walk.

- Everything **off** the route drops to `opacity: 0.18` (track and segments) or `0.22` (labels and signal heads). It darkens rather than disappearing, because an unlit segment is a real state on this instrument, not an absence.
- The route's **track** — crossovers and running lines alike — restrokes to `lit-done`. One value, not a per-hop gradient: a route is set or it is not.
- The route's **berths** keep their own state colour and simply are not dimmed. **This is a deliberate divergence from `c-route.png`**, which paints the whole set route — berths included — as one unbroken `#0fa804` green, and carries no amber or red anywhere on the panel. Following the comp would have cost the reader the one thing the lit route is meant to make legible: a route answers "what is on this task's lineage", and each berth on it still has to answer "and what is that one doing right now". Collapsing both into a single green turns the panel's most informative moment into its least.
- The hovered berth itself takes a 2px `text`-coloured stroke.
- The running line is drawn in **segments, one per clear gap**, so a dependency that reaches past a berth of its own bucket breaks the lit run at that berth instead of lighting through it. Lighting straight through would claim a clear road where an intermediate task is still holding things up.
- The transition is 150ms on `fill`, `stroke`, and `opacity` — segments light, they do not slide or fade in.

### Header

Sticky, `surface`, 64px minimum, with the plan title over a `repo/slug` line, a 32px progress ring (2px stroke, `rule` track, `done` value arc, butt cap, rotated -90°), the elapsed clock and token rollup as right-aligned figures under uppercase labels, a definition list of state counts each in its own state colour, and a two-button view toggle. An error or loading strip spans the full header width beneath the row, `surface-2`, and turns alert-coloured for a tree error.

### Task Card / Lane

Cards in a horizontally scrolling strip of `surface` lanes with `surface-2` headings, 4px radius, 1px rule, 12px padding. A card carries a 6px square status swatch in its state colour, a mono ref caption, a sans title, outlined badges that take the state colour on both text and border, a token figure aligned to the end, and — when expandable — a `surface-2` hover and a rubric breakdown well beneath.

### Fleet Table

The manifest. A seven-column grid at 12px mono with 1px rule row separators, a `surface-2` column header sticking exactly below the 44px heading, and a 6px square status dot per row: done green, flight amber and pulsing, failed and rejected coral, abandoned slate. A role badge picks up the same colour. A rejected row promotes its message from muted to full text, because that cell is where a failed gate says why.

### Meters

One shape for both views: a 4px `surface-2` track, a flat fill in `done` / `alert` / `flight` by verdict, and a 1px `text`-coloured threshold marker standing in it. Rubric dimensions use a `rule` track with a `ready` fill, the bar's own width scaled to the dimension's weight.

### Motion

- `--motion-duration: 150ms` on colour and opacity transitions. Nothing moves position.
- `--flight-duration: 2s` `flight-pulse`, an opacity cycle to 0.45 and back, on the three in-flight markers: the header status dot, the fleet status dot, and an in-flight berth's leading edge. This animation is **deck-wide and predates the panel redesign** — the two dots have always used it. It is worth naming that a fade is in tension with the panel's own rule that segments light rather than fade; the pulse is retained because it is the deck's one existing "this is happening now" signal and an in-flight berth reading differently from an in-flight fleet row would be worse. It is also the reason the reduced-motion rule below is not optional.
- `prefers-reduced-motion: reduce` kills every animation and transition on the deck with one global rule.

## Do's and Don'ts

### Do:
- **Do** express state by lighting one hue to a brighter value — lit, base, unlit — and keep the pinned state colour as the base step.
- **Do** mix lit steps toward `white` and unlit steps toward `--ground`, both in oklab.
- **Do** keep every unlit berth's leading edge at least one value step above the rail its plate sits on.
- **Do** give every colour a label, a count, or a shape beside it.
- **Do** derive the panel's geometry and type from `FONT_SIZE = 14`; change the constant, not the individual values.
- **Do** measure the pane off the DOM for the two quantities that answer to it, and read the fitted values back from `layout.geometry` rather than re-deriving them.
- **Do** let the pane scroll past the compression floor, and theme its scrollbar from the palette.
- **Do** keep every line in the panel horizontal, at the rail's own stroke weight, and leave the crossover as the one thing that curves.
- **Do** keep monospace as the default voice and reserve the sans face for a human sentence.
- **Do** convey depth by stepping `ground` → `surface` → `surface-2` with 1px `rule` hairlines.

### Don't:
- **Don't** add a gradient, a glow, a drop shadow, a bevel, glassmorphism, or a backdrop blur. The header's zero-blur 1px `box-shadow` is a doubled border, not an exception.
- **Don't** exceed a 4px corner radius, and never make a pill.
- **Don't** introduce a sixth state colour, and never use purple, violet, or neon — that register belongs to the cockpit's world.
- **Don't** put an arrowhead on a dependency. A signalling panel has none, and left-to-right layout already carries direction; the marker that used to ship never rendered at all, because it was shorter than the stroke it sat on.
- **Don't** grade the lineage by hop count. A route is set or it is not, at one value.
- **Don't** wrap the token count in a pill or a chip. It is plain text under the ref.
- **Don't** literalize the railway: berth numbers stay `bucket/NN`, road labels stay bucket names, and the region under the panel stays the agent fleet. The world dresses the diagram, never the data.
- **Don't** draw track across a berth, or let a diagonal find its own angle to avoid one.
- **Don't** light a running line straight through an intermediate berth of the same bucket.
- **Don't** ship a light mode or a theme control.
- **Don't** use emoji as a status indicator.
</content>
