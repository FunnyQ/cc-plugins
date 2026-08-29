/*
 * DIRECTION CONTRACT — Interlocking Panel
 *
 * THESIS: a flight plan is a route set through a signalling panel, not a bag of
 * coloured boxes on a canvas. It refuses the node-graph editor this category
 * always ships — and that this file used to be.
 * OWN-WORLD: a railway NX entrance-exit desk on Hangar's near-black ground.
 * Buckets are named running roads; tasks are berth plates on them; cross-bucket
 * dependencies are crossovers changing road; gates are signal heads.
 * State is lit, not filled: every state colour carries lit / base / unlit steps
 * on one hue, by value alone — no gradient and no shadow, and no box takes a
 * corner above 4px. The panel held to exactly two angles — horizontal and 45 —
 * until the crossover became a curve; that is now its one curved element, and
 * the rule it broke is recorded rather than quietly dropped.
 * STORY: the reader asks what is holding a task up and what moves when it
 * lands, and reads the answer as one lit line instead of tracing edges.
 * FIRST VIEWPORT: roads stack down the pane with their bucket names in the left
 * and right gutters; berths sit along each road at dependency depth as plates
 * carrying their own ref and token, lit down the leading edge; crossovers carry
 * every dependency that leaves its own road; the whole field is lit at rest.
 * FORM: Interlocking Panel, rank 1 of my grounded list, taken by the user over
 * the roll's assigned Drawing Sheet. Seed key 5e8c7193.
 * Approved comps: .impeccable/mocks/comp/b-throat.png (rest) + c-route.png
 * (hover). Signature interaction: hovering a berth darkens the panel and lights
 * that task's whole lineage end to end. Motion: segments light, never fade.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the
 * finish review, the verdict, DESIGN.md, and every shipping raster carrying its
 * provenance.
 */

import {
  compareTaskOrder,
  escapeHtml,
  formatTokens,
  hasTokenReading,
} from "./format.js";

// Left-to-right layout: a dependency chain reads along the reading direction,
// and a wide node fits a full `bucket/NN` ref at a legible size instead of
// shrinking to fit a narrow column.
//
// The type size is the one fixed quantity — the SVG renders at its natural
// size, so 14 here is 14 real pixels — and every box, gap, and margin is a
// multiple of it. Change FONT_SIZE and the whole diagram rescales in
// proportion; nothing has to be re-tuned by hand.
const FONT_SIZE = 14;

const geometry = (fontSize) => ({
  // A berth is a berth plate: the ref and the token ride *inside* it, with a
  // state bar down its leading edge, the way a terminal prints one record per
  // line. They used to hang beneath as two free-floating lines of text, which
  // split every task into a coloured bar over here and an identity over there
  // and made the reader pair them up before a single berth could be read.
  //
  // The plate is still a block of track, not a card: it sits ON the rail, keeps
  // the panel's 2px corner, and takes no shadow and no gradient.
  fontSize,
  berthHeight: fontSize * 2.85,
  berthPadX: fontSize * 0.55,
  statusWidth: fontSize * 0.3, // the lit leading edge
  refGap: fontSize * 0.9, // between the ref and the token inside the plate
  minBerthWidth: fontSize * 7, // never narrower than the bar it replaced
  // The running line. It was the berth's own height while a berth *was* the
  // line; now that the plate stands on it, the two are separate quantities and
  // the rail keeps the weight it always drew at.
  railWidth: fontSize * 0.85,
  slotGap: fontSize * 6, // between berths along one road (x) — crossovers land here
  roadPitch: fontSize * 5, // between roads (y)
  // A road band never grows past about twice the ink it carries: a signal head
  // above the line and the berth plate. Past that the roads drift apart and the
  // panel is dead space again, only moved inside itself.
  maxRoadPitch: fontSize * 9,
  gutter: fontSize * 9, // road name, both ends, mirrored as on the comp — a cap
  minGutter: fontSize * 2,
  // The gap is now the crossover's entire horizontal reach, not just somewhere
  // for a signal head to stand, so the floor answers to the curve: below about
  // this a change of road has no room to be a curve and reads as a kink in the
  // rail. It was fontSize * 2.5 while the diagonal spent its own drop in reach
  // and only the head had to fit. Raising it means a long plan reaches the
  // scroll sooner, which is the trade the panel already takes elsewhere.
  minSlotGap: fontSize * 4,
  padding: fontSize,
  // A three-aspect head standing on the running line. Tall enough to break the
  // plate's own silhouette — a head shorter than the berth reads as a fitting
  // hanging off it rather than a signal standing beside it.
  signalWidth: fontSize * 1.25,
  signalHeight: fontSize * 4,
  signalLamp: fontSize * 0.34,
  // How hard a crossover's S-curve bends, as a fraction of the gap it turns in.
  // Unitless and deliberately not derived from the type size: it shapes a curve
  // whose footprint is already fixed by that gap, so it rescales with nothing.
  crossoverEase: 0.5,
});

/*
 * The gutter holds the road name and nothing else.
 *
 * A flat allowance spends the same width on `ui` as on `contract`, and at four
 * roads that overspend — 126px a side against 54px of ink — is most of what
 * pushed the last berth and its token off the pane. The label renders at 0.8 of
 * the type size in the monospace stack, whose advance is ~0.6em, so the name's
 * own length plus one character of air is the honest width. The flat value
 * stays as the cap, so no road name can push the panel wider than it used to.
 *
 * Rounded to a whole pixel: every berth's x is this plus a multiple of the
 * stride, so a gutter carrying float error spreads it across the whole panel,
 * where the render's own two-decimal trim then rounds it back out and the
 * coordinates stop matching the layout that produced them.
 */
// The monospace stack's advance, and the three type sizes drawn against it.
// One place, because the gutter and the berth plate both size themselves to
// their own ink and a second copy of 0.6 drifts from the first.
const MONO_ADVANCE = 0.6;
const ROAD_NAME_SCALE = 0.8;
const REF_SCALE = 0.85;
const TOKEN_SCALE = 0.75;

const advance = (characters, scale, fontSize) =>
  characters * fontSize * scale * MONO_ADVANCE;

const gutterFor = (roadNames, options) => {
  const longest = Math.max(0, ...roadNames.map((name) => name.length));
  return Math.round(
    Math.min(
      options.gutter,
      Math.max(
        options.minGutter,
        advance(longest, ROAD_NAME_SCALE, options.fontSize) + options.fontSize,
      ),
    ),
  );
};

/*
 * The plate holds its own text, so its width is that text's width.
 *
 * One shared value taken from the longest ref, not a per-node width: every
 * berth's x is the gutter plus a multiple of the stride, and a per-node width
 * would break the stride, which is the only reason slots read as columns across
 * roads. Rounded to a whole pixel for the same reason the gutter is.
 *
 * The token column is held at a fixed six characters (`145.0K`) whether or not
 * a reading has arrived. Sizing it to the readings actually present would
 * reflow the entire panel the first time a task reports its tokens — and this
 * panel is read while it runs, so a layout that moves under the reader costs
 * more than a plate carrying some empty column.
 *
 * There is no cap. A gutter is a flat allowance spent on a road name and can be
 * capped without lying; a plate that cannot fit its own ref renders a truncated
 * task id, which is a lie about the plan. Past the pane the panel scrolls.
 */
const TOKEN_COLUMNS = 6;

const berthWidthFor = (nodes, options) => {
  const longest = Math.max(
    0,
    ...nodes.map(({ ref }) => String(ref ?? "").length),
  );
  return Math.round(
    Math.max(
      options.minBerthWidth,
      options.statusWidth +
        options.berthPadX * 2 +
        advance(longest, REF_SCALE, options.fontSize) +
        options.refGap +
        advance(TOKEN_COLUMNS, TOKEN_SCALE, options.fontSize),
    ),
  );
};

const DEFAULTS = geometry(FONT_SIZE);

const resolve = (opts) => ({
  ...(opts.fontSize ? geometry(opts.fontSize) : DEFAULTS),
  ...opts,
});

export function layoutGraph(nodes, opts = {}) {
  const options = resolve(opts);
  const orderedNodes = [...(Array.isArray(nodes) ? nodes : [])].sort(
    compareTaskOrder,
  );
  const refs = new Set(orderedNodes.map(({ ref }) => ref));
  const depths = new Map();

  // A valid longest path settles within node count passes. The cap leaves
  // cycles and anything downstream of them visibly unsettled instead of hanging.
  // Each pass reads the depths the previous pass left, so a node settles only
  // after its dependencies did; a pass that changes nothing is the fixed point.
  for (let pass = 0; pass < orderedNodes.length; pass += 1) {
    const previous = new Map(depths);
    let changed = false;

    for (const node of orderedNodes) {
      const dependencies = (node.dependsOn ?? []).filter((ref) =>
        refs.has(ref),
      );
      const depth = dependencies.length
        ? dependencies.every((ref) => previous.get(ref) !== undefined)
          ? 1 + Math.max(...dependencies.map((ref) => previous.get(ref)))
          : undefined
        : 0;

      if (depth !== undefined && previous.get(node.ref) !== depth) {
        depths.set(node.ref, depth);
        changed = true;
      }
    }

    if (!changed) break;
  }

  const cyclic = orderedNodes
    .filter(({ ref }) => !depths.has(ref))
    .map(({ ref }) => ref);
  const finalDepth = depths.size ? Math.max(...depths.values()) + 1 : 0;
  for (const ref of cyclic) depths.set(ref, finalDepth);

  const drawn = drawableEdges(orderedNodes, new Set(cyclic));

  // One road per bucket, in the order /api/tree already sorted them into. The
  // road is the only thing that decides y: a task never leaves its bucket's
  // line, which is what makes a crossover mean "this dependency left its
  // bucket" rather than "the layout needed the room".
  const roadNames = [];
  const roadOf = new Map();
  for (const node of orderedNodes) {
    const bucket = node.bucket ?? "";
    if (!roadOf.has(bucket)) {
      roadOf.set(bucket, roadNames.length);
      roadNames.push(bucket);
    }
  }

  /*
   * Slot, not raw depth.
   *
   * Depth alone would stack two berths of one bucket on the same spot when they
   * sit at the same depth — on a road that is two trains in one block, and it
   * renders as one berth hiding another. So each road walks its own tasks in
   * (depth, nn) order and takes the first free slot at or after their depth.
   * Columns stay aligned across roads wherever the tree allows it, and the road
   * stays strictly left-to-right, which is the one thing a running line must be.
   */
  const slots = new Map();
  for (const road of roadNames) {
    const onRoad = orderedNodes
      .filter((node) => (node.bucket ?? "") === road)
      .sort(
        (left, right) =>
          (depths.get(left.ref) ?? 0) - (depths.get(right.ref) ?? 0) ||
          compareTaskOrder(left, right),
      );
    let previous = -1;
    for (const node of onRoad) {
      const slot = Math.max(depths.get(node.ref) ?? 0, previous + 1);
      slots.set(node.ref, slot);
      previous = slot;
    }
  }

  /*
   * Vertical composition.
   *
   * The panel is the instrument, not a picture hung inside one, so the roads
   * spread into the height the pane actually offers instead of floating as a
   * short band in the middle of it. `availableHeight` is the pane's content box;
   * without it the panel keeps its natural pitch, which is what every test and
   * every one-road plan gets.
   *
   * `headroom` is what a signal head needs above the first running line, and
   * `footroom` what the berth plate needs below the last one. Both are fixed,
   * so only the space between roads stretches — and only up to `maxRoadPitch`.
   */
  const roadCount = Math.max(roadNames.length, 1);
  const headroom =
    options.padding +
    Math.max(0, options.signalHeight - options.berthHeight) / 2;
  const footroom = options.berthHeight + options.padding;
  const spread =
    (options.availableHeight - headroom - footroom) / (roadCount - 1);
  const roadPitch =
    roadCount > 1 && Number.isFinite(spread)
      ? Math.min(options.maxRoadPitch, Math.max(options.roadPitch, spread))
      : options.roadPitch;

  /*
   * Horizontal composition — the same rule as the vertical, in the other axis.
   *
   * The panel fits the pane it is given. `availableWidth` is the pane's content
   * box; without it the panel keeps its natural gap, which is what every test
   * gets. Only the gaps between berths compress: a berth plate holds a full
   * `bucket/NN` and its token at a legible size and never shrinks, and the
   * gutters are already sized to their own ink. Below `minSlotGap` the panel
   * scrolls instead, which is the honest answer — `.c-dependency-graph` themes
   * its scrollbar so that affordance is visible rather than inferred.
   *
   * The gaps are one per slot plus the trailing one the road runs out on.
   */
  const lastSlot = slots.size ? Math.max(...slots.values()) : 0;
  const gutter = opts.gutter ?? gutterFor(roadNames, options);
  const berthWidth = opts.berthWidth ?? berthWidthFor(orderedNodes, options);
  const gapCount = lastSlot + 2;
  const room =
    (options.availableWidth -
      options.padding * 2 -
      gutter * 2 -
      (lastSlot + 1) * berthWidth) /
    gapCount;
  // Floored for the same reason the gutter is rounded, and floored rather than
  // rounded so the fitted panel never comes out a pixel wider than it measured.
  const slotGap = Number.isFinite(room)
    ? Math.min(options.slotGap, Math.max(options.minSlotGap, Math.floor(room)))
    : options.slotGap;

  const stride = berthWidth + slotGap;
  const positions = new Map();
  for (const node of orderedNodes) {
    positions.set(node.ref, {
      x: options.padding + gutter + (slots.get(node.ref) ?? 0) * stride,
      y: headroom + (roadOf.get(node.bucket ?? "") ?? 0) * roadPitch,
      road: roadOf.get(node.bucket ?? "") ?? 0,
      slot: slots.get(node.ref) ?? 0,
    });
  }

  const roads = roadNames.map((name, index) => ({
    name,
    index,
    y: headroom + index * roadPitch + options.berthHeight / 2,
  }));

  /*
   * Where each crossover is allowed to change roads.
   *
   * A diagonal drawn straight between two berths runs over whatever sits
   * between them — on the first render of this panel, `contract/02 -> server/04`
   * drove straight through `server/03`'s segment. Track crossing track is
   * ordinary on a signalling diagram; track crossing a *berth* is not, and it
   * reads as one task passing through another.
   *
   * The gaps between slots are the only columns nothing occupies, so a
   * crossover changes roads inside one of them. A gap is usable when no road it
   * has to cross holds a berth in that slot — the gap after slot n is blocked
   * for a road that owns both slot n and slot n+1, because its own running line
   * is continuous there. The first usable gap wins, so the change of road
   * happens as early as it can and the diagonal stays short.
   */
  const occupied = new Set();
  for (const [ref, p] of positions) occupied.add(`${p.road}:${p.slot}`);
  const turns = new Map();
  for (const key of drawn) {
    const [from, to] = key.split(EDGE_SEPARATOR);
    const source = positions.get(from);
    const target = positions.get(to);
    if (!source || !target || source.road === target.road) continue;

    const low = Math.min(source.road, target.road);
    const high = Math.max(source.road, target.road);
    let chosen = source.slot;
    for (let slot = source.slot; slot < target.slot; slot += 1) {
      const clear = (() => {
        for (let road = low; road <= high; road += 1) {
          if (road === source.road || road === target.road) continue;
          if (
            occupied.has(`${road}:${slot}`) ||
            occupied.has(`${road}:${slot + 1}`)
          ) {
            return false;
          }
        }
        return true;
      })();
      if (clear) {
        chosen = slot;
        break;
      }
      chosen = slot;
    }
    // Centre of the gap that follows the chosen slot.
    turns.set(
      key,
      options.padding + gutter + chosen * stride + berthWidth + slotGap / 2,
    );
  }

  // The road runs the full width whether or not a berth sits at the far end, so
  // the extent is the track's length, not the last berth's edge.
  const extent = {
    width: options.padding * 2 + gutter * 2 + (lastSlot + 1) * stride + slotGap,
    height: headroom + (roadCount - 1) * roadPitch + footroom,
  };

  // The three quantities that answer to the plan and the pane rather than to
  // the type size. The render reads them back instead of re-deriving from the
  // defaults, which is how the signal heads and the road ends would otherwise
  // land on a gutter, a gap and a plate the layout never used. Named `fitted`,
  // not `geometry`: the module already has a `geometry()` builder, and a local
  // of that name here shadows it for the rest of this function.
  const fitted = { gutter, slotGap, berthWidth };

  return {
    positions,
    roads,
    roadOf,
    slots,
    turns,
    cyclic,
    drawn,
    extent,
    geometry: fitted,
  };
}

/**
 * Every node on the hovered node's lineage: itself, everything it transitively
 * depends on, and everything that transitively depends on it. Two breadth-first
 * walks over a `seen` set, so a cycle terminates instead of spinning.
 *
 * Lineage rather than immediate neighbours, because the two questions a
 * dependency graph gets asked are "what is holding this up" and "what starts
 * moving when this lands" — both reach past one hop.
 */
export function relatedRefs(nodes, ref) {
  const graphNodes = Array.isArray(nodes) ? nodes : [];
  const known = new Set(graphNodes.map((node) => node.ref));
  if (!known.has(ref)) return new Set();

  const dependencies = new Map(
    graphNodes.map((node) => [
      node.ref,
      (node.dependsOn ?? []).filter((dep) => known.has(dep)),
    ]),
  );
  const dependents = new Map(graphNodes.map((node) => [node.ref, []]));
  for (const [target, deps] of dependencies) {
    for (const dep of deps) dependents.get(dep).push(target);
  }

  const related = new Set([ref]);
  for (const edges of [dependencies, dependents]) {
    const queue = [ref];
    const seen = new Set([ref]);
    while (queue.length) {
      for (const next of edges.get(queue.shift()) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        related.add(next);
        queue.push(next);
      }
    }
  }
  return related;
}

/**
 * The edges worth drawing: the graph's transitive reduction.
 *
 * `u → v` is dropped when some *other* dependency of `v` already reaches `u`,
 * because the path through that dependency says the same thing. Reachability is
 * identical either way — only the picture changes.
 *
 * How much this removes is a property of how the plan was written, not of the
 * planner. `lint-task.ts` only requires the closing final-review task to *reach*
 * every other task, and a well-written one satisfies that transitively: measured
 * across three real trees, its `Depends on` ran from 1 entry to 4, and the
 * redundant share of all edges from 13% to 43%. The worst case converges every
 * edge on one node, where they overlap outright.
 *
 * A cyclic node keeps all of its edges: inside a cycle every node reaches every
 * other, so reduction would erase exactly the edges the reader needs to see.
 */
// One explicit separator for both sides of the lookup. A ref cannot contain it.
const EDGE_SEPARATOR = "->";
const edgeKey = (from, to) => `${from}${EDGE_SEPARATOR}${to}`;

export function drawableEdges(graphNodes, cyclic = new Set()) {
  const dependsOn = new Map(
    graphNodes.map((node) => [node.ref, node.dependsOn ?? []]),
  );
  const closures = new Map();

  // Cycle-safe by the `seen` set: a cycle stops re-entering, it does not spin.
  const closureOf = (ref) => {
    const cached = closures.get(ref);
    if (cached) return cached;

    const seen = new Set();
    const stack = [...(dependsOn.get(ref) ?? [])];
    while (stack.length) {
      const next = stack.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(dependsOn.get(next) ?? []));
    }
    closures.set(ref, seen);
    return seen;
  };

  const keep = new Set();
  for (const node of graphNodes) {
    const dependencies = dependsOn.get(node.ref) ?? [];
    for (const ref of dependencies) {
      const redundant =
        !cyclic.has(node.ref) &&
        !cyclic.has(ref) &&
        dependencies.some(
          (other) => other !== ref && closureOf(other).has(ref),
        );
      if (!redundant) keep.add(edgeKey(ref, node.ref));
    }
  }
  return keep;
}
/** Two decimals keeps the path readable in devtools without visible drift. */
const trim = (value) => Math.round(value * 100) / 100;

/**
 * A crossover: horizontal run, an S-curve that changes road, horizontal run.
 *
 * A signalling diagram has exactly two angles, and the panel held to them until
 * this: the change of road was a straight 45-degree diagonal, latterly with its
 * corners filleted. Rounding only the joints turned out to be a change the eye
 * cannot find — at any radius small enough to leave the 45 visibly straight, the
 * arc hides inside the 11.9px stroke and the corner still reads as square. So
 * the whole diagonal becomes the curve. What that costs is real: the panel now
 * has one shape that is neither horizontal nor 45, and a reader tracing a line
 * no longer meets only two angles.
 *
 * The reach is the gap, not the drop. Holding 45 forced the diagonal to spend
 * its own vertical drop in horizontal reach, and on a panel four roads tall that
 * was routinely more than the span between the two berths — so most crossovers
 * fell through to the straight-line fallback and the curve was drawn on almost
 * none of them. A curve owes nothing to that ratio: it changes road inside the
 * one gap `turns` reserved however far apart the roads are, which both makes it
 * visible everywhere and *tightens* the old guarantee. The 45-degree diagonal
 * overflowed its reserved gap by however much its drop exceeded the gap width;
 * this cannot leave the gap at all.
 *
 * Both ends leave horizontally, because the curve meets a road there and track
 * that meets track at an angle is a kink. That is what the control points are
 * doing on their endpoints' own y.
 *
 * A free-angle bezier drawn straight between the two berths would abandon the
 * reserved gap outright, and on a real tree it sweeps over the plates on the
 * roads in between. That is the shape this is not.
 */
function crossoverPath(x1, y1, x2, y2, turnX, { ease = 0.5, reach = 0 } = {}) {
  const drop = Math.abs(y2 - y1);
  const span = x2 - x1;
  if (drop === 0) return `M ${trim(x1)},${trim(y1)} L ${trim(x2)},${trim(y2)}`;

  // The change of road is centred on the reserved gap and no wider than it, so
  // it happens in a column no berth occupies. Clamped to the span as well, for
  // the crossover whose two berths sit closer together than one gap.
  const width = Math.min(reach, span);
  if (!(width > 0)) {
    return `M ${trim(x1)},${trim(y1)} L ${trim(x2)},${trim(y2)}`;
  }

  const centre = Number.isFinite(turnX) ? turnX : x1 + span / 2;
  const start = Math.min(Math.max(centre - width / 2, x1), x2 - width);

  /*
   * How far each control point reaches across the curve's own width.
   *
   * Pinning both control points to their endpoints' y is what keeps the ends
   * horizontal, and it also means this can never straighten back into the 45:
   * at 0 it is the gentlest S the shape allows — a smoothstep — and as it grows
   * the ends flatten against their roads while the middle steepens.
   *
   * Clamped to 1 because that is what holds the footprint. A bezier is contained
   * by the convex hull of its control points, so while all four x's stay inside
   * `[start, start + width]` the curve cannot leave the gap the routing reserved
   * for it; past 1 the leading control point escapes that gap and the curve
   * bulges out over whatever is beside it. Past 0.5 the two control points do
   * cross each other, which looks alarming and is not: x stays monotonic for
   * every ease in range — its derivative bottoms out at `0.5 * (1 - ease)` — so
   * the curve steepens through the middle rather than doubling back.
   */
  const bend = width * Math.min(Math.max(ease, 0), 1);
  return [
    `M ${trim(x1)},${trim(y1)}`,
    `L ${trim(start)},${trim(y1)}`,
    `C ${trim(start + bend)},${trim(y1)} ${trim(start + width - bend)},${trim(y2)} ${trim(start + width)},${trim(y2)}`,
    `L ${trim(x2)},${trim(y2)}`,
  ].join(" ");
}

/**
 * A signal head: a three-aspect housing standing on the running line, with the
 * aspect it shows lit and the other two dark.
 *
 * Three lamps rather than one, in the real top-to-bottom order — green, yellow,
 * red — because the stacked silhouette is what makes it a signal at a glance,
 * and where in the stack the light sits is readable before its colour is. The
 * first build drew one lamp in a box the same height as the rail it sat on: the
 * box vanished into the track and the lamp read as a speck of dirt on it.
 *
 * The housing is opaque and centred on the line, so the rail passes behind it
 * exactly as it does behind a real head's backplate.
 */
const SIGNAL_ASPECTS = ["clear", "caution", "danger"];

function signalHead(x, y, options, aspect) {
  const { signalWidth: width, signalHeight: height } = options;
  const lampPitch = height / 3.4;
  const lamps = SIGNAL_ASPECTS.map(
    (name, index) =>
      `<circle class="lamp -${name}" cx="${trim(x)}" cy="${trim(y + (index - 1) * lampPitch)}" r="${trim(options.signalLamp)}" />`,
  ).join("");

  return `<g class="graph-signal -${aspect}">
        <rect class="housing" x="${trim(x - width / 2)}" y="${trim(y - height / 2)}" width="${trim(width)}" height="${trim(height)}" rx="2" ry="2" />
        ${lamps}
      </g>`;
}

export function renderGraph(nodes, layout, opts = {}) {
  const { usage, ...geometryOpts } = opts;
  // The layout's own gutter, gap and plate width win: it sized them to the road
  // names, the refs and the pane, and a render that re-derived them from the
  // defaults would put the signal heads and the road ends somewhere the berths
  // are not.
  const options = { ...resolve(geometryOpts), ...(layout.geometry ?? {}) };
  const tokensByRef = usage?.byTask ?? {};
  const graphNodes = Array.isArray(nodes) ? nodes : [];
  const { positions, roads, drawn, turns } = layout;
  const cyclic = new Set(layout.cyclic);
  const width = Math.max(
    options.berthWidth + options.padding * 2,
    layout.extent.width,
  );
  const height = Math.max(
    options.roadPitch + options.padding * 2,
    layout.extent.height,
  );
  const trackEnd = width - options.padding - options.gutter;
  const trackStart = options.padding + options.gutter;

  // The running roads, drawn first and full width, so every berth sits ON a
  // line that exists whether or not the plan reaches that far along it.
  const roadLines = roads
    .map(
      (road) => `<g class="graph-road" data-road="${escapeHtml(road.name)}">
        <line class="rail" stroke-width="${trim(options.railWidth)}" x1="${trim(trackStart)}" y1="${trim(road.y)}" x2="${trim(trackEnd)}" y2="${trim(road.y)}" />
        <text class="graph-road-name -left" font-size="${options.fontSize * ROAD_NAME_SCALE}" x="${trim(trackStart - options.fontSize * 0.75)}" y="${trim(road.y + options.fontSize * 0.3)}">${escapeHtml(road.name)}</text>
        <text class="graph-road-name -right" font-size="${options.fontSize * ROAD_NAME_SCALE}" x="${trim(trackEnd + options.fontSize * 0.75)}" y="${trim(road.y + options.fontSize * 0.3)}">${escapeHtml(road.name)}</text>
      </g>`,
    )
    .join("");

  /*
   * The running line between two berths of one bucket.
   *
   * A dependency inside a bucket is the road itself, so at rest this draws
   * nothing new: the same unlit stroke at the same weight, laid over the rail
   * that is already there. It exists for the set route. The approved hover comp
   * lights a route *end to end* — track included — and without these the lit
   * line stopped at every berth edge and resumed at the next one, which reads as
   * a route that is not set.
   *
   * It is drawn in segments, one per clear gap, because a dependency can reach
   * past a berth of its own bucket: `ui/04` depends on both `ui/02` and `ui/03`,
   * and the reduction keeps `ui/02 -> ui/04`, which spans `ui/03`'s slot. One
   * unbroken line there lights straight through `ui/03` — a berth on neither end
   * of the lineage — and says `ui/02` runs clear to `ui/04` when `ui/03` is
   * holding it up too. The berth breaks the lit run instead, which is what an
   * unset section of a route looks like on the real instrument.
   */
  const berthsByRoad = new Map();
  for (const position of positions.values()) {
    const onRoad = berthsByRoad.get(position.road) ?? [];
    onRoad.push(position);
    berthsByRoad.set(position.road, onRoad);
  }

  const links = graphNodes
    .flatMap((node) => {
      const target = positions.get(node.ref);
      if (!target) return [];
      return (node.dependsOn ?? []).flatMap((dependencyRef) => {
        if (!drawn.has(edgeKey(dependencyRef, node.ref))) return [];
        const source = positions.get(dependencyRef);
        if (!source || source.road !== target.road) return [];

        const y = source.y + options.berthHeight / 2;
        const blockers = (berthsByRoad.get(source.road) ?? [])
          .filter(({ slot }) => slot > source.slot && slot < target.slot)
          .sort((left, right) => left.x - right.x);

        let from = source.x + options.berthWidth;
        const spans = [];
        for (const blocker of [...blockers, target]) {
          spans.push([from, blocker.x]);
          from = blocker.x + options.berthWidth;
        }

        return spans.map(
          ([x1, x2]) =>
            `<line class="graph-link" stroke-width="${trim(options.railWidth)}" data-from="${escapeHtml(dependencyRef)}" data-to="${escapeHtml(node.ref)}" x1="${trim(x1)}" y1="${trim(y)}" x2="${trim(x2)}" y2="${trim(y)}" />`,
        );
      });
    })
    .join("");

  // Crossovers carry only the dependencies that leave their own road.
  const crossovers = graphNodes
    .flatMap((node) => {
      const target = positions.get(node.ref);
      if (!target) return [];
      return (node.dependsOn ?? []).flatMap((dependencyRef) => {
        if (!drawn.has(edgeKey(dependencyRef, node.ref))) return [];
        const source = positions.get(dependencyRef);
        if (!source || source.road === target.road) return [];
        const dependency = graphNodes.find((n) => n.ref === dependencyRef);
        return [
          `<path class="graph-crossover${dependency?.state === "done" ? " -cleared" : ""}" stroke-width="${trim(options.railWidth)}" data-from="${escapeHtml(dependencyRef)}" data-to="${escapeHtml(node.ref)}" d="${crossoverPath(
            source.x + options.berthWidth,
            source.y + options.berthHeight / 2,
            target.x,
            target.y + options.berthHeight / 2,
            turns?.get(edgeKey(dependencyRef, node.ref)),
            { ease: options.crossoverEase, reach: options.slotGap },
          )}" />`,
        ];
      });
    })
    .join("");

  const berths = graphNodes
    .flatMap((node) => {
      const position = positions.get(node.ref);
      if (!position) return [];

      const isCyclic = cyclic.has(node.ref);
      const hardFailed = node.latestScore?.hardFailed === true;
      const state = isCyclic ? "cyclic" : hardFailed ? "alert" : node.state;
      const centreX = position.x + options.berthWidth / 2;
      const midY = position.y + options.berthHeight / 2;
      // Mono text centred on the plate: half the type size back off the middle
      // puts the x-height band on the centre line, which is where the eye reads
      // it. A raw baseline at midY hangs the whole word above the plate's waist.
      const textY = midY + options.fontSize * REF_SCALE * 0.35;
      const tokens = tokensByRef[node.ref]?.output;
      // Untiered: a berth's figure is the whole task, several agents deep, so the
      // per-agent thresholds would paint every berth on any real run.
      //
      // Right-aligned against the plate's inner edge, so the counts form a
      // column down each road and can be compared without reading any of them.
      const tokenLine = !hasTokenReading(tokens)
        ? ""
        : `<text class="graph-tokens" font-size="${options.fontSize * TOKEN_SCALE}" x="${trim(position.x + options.berthWidth - options.berthPadX)}" y="${trim(textY)}">${escapeHtml(formatTokens(tokens))}</text>`;
      // A gate stands at the entry of any berth something has to clear first.
      const aspect = isCyclic
        ? "danger"
        : node.state === "done"
          ? "clear"
          : node.state === "blocked"
            ? "danger"
            : "caution";
      const signal = (node.dependsOn ?? []).length
        ? signalHead(position.x - options.slotGap / 2, midY, options, aspect)
        : "";

      return [
        `
      <g class="graph-berth -${escapeHtml(state)}" data-ref="${escapeHtml(node.ref)}">
        ${signal}
        <rect class="segment" x="${trim(position.x)}" y="${trim(position.y)}" width="${trim(options.berthWidth)}" height="${trim(options.berthHeight)}" rx="2" ry="2" />
        <rect class="status" x="${trim(position.x)}" y="${trim(position.y)}" width="${trim(options.statusWidth)}" height="${trim(options.berthHeight)}" rx="2" ry="2" />
        <text class="graph-ref" font-size="${options.fontSize * REF_SCALE}" x="${trim(position.x + options.statusWidth + options.berthPadX)}" y="${trim(textY)}">${escapeHtml(node.ref)}</text>
        ${tokenLine}
        ${isCyclic ? `<text class="graph-cycle-label" font-size="${options.fontSize * 0.7}" x="${trim(centreX)}" y="${trim(position.y - options.fontSize * 0.4)}">CYCLE</text>` : ""}
      </g>`,
      ];
    })
    .join("");

  const empty = graphNodes.length
    ? ""
    : '<text class="graph-empty" x="50%" y="50%">No tasks in this flight tree.</text>';
  const cycleNote = cyclic.size
    ? `<text class="graph-cycle-note" x="${trim(width / 2)}" y="${trim(height - options.padding / 2)}">Cycle: ${escapeHtml([...cyclic].join(", "))}</text>`
    : "";

  return `<svg class="dependency-graph" width="${trim(width)}" height="${trim(height)}" viewBox="0 0 ${trim(width)} ${trim(height)}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Task dependency panel" xmlns="http://www.w3.org/2000/svg">${roadLines}${links}${crossovers}${berths}${cycleNote}${empty}</svg>`;
}
