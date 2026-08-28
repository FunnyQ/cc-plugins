/*
 * DIRECTION CONTRACT — Interlocking Panel
 *
 * THESIS: a flight plan is a route set through a signalling panel, not a bag of
 * coloured boxes on a canvas. It refuses the node-graph editor this category
 * always ships — and that this file used to be.
 * OWN-WORLD: a railway NX entrance-exit desk on Hangar's near-black ground.
 * Buckets are named running roads; tasks are berth segments on them;
 * cross-bucket dependencies are diagonal crossovers; gates are signal heads.
 * State is lit, not filled: every state colour carries lit / base / unlit steps
 * on one hue, by value alone — no gradient, no shadow, no radius above 4px.
 * STORY: the reader asks what is holding a task up and what moves when it
 * lands, and reads the answer as one lit line instead of tracing edges.
 * FIRST VIEWPORT: roads stack down the pane with their bucket names in the left
 * and right gutters; berths sit along each road at dependency depth, ref and
 * token beneath; crossovers carry every dependency that leaves its own road;
 * the whole field is lit at rest.
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
  tokenTier,
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
const ARROW_ID = "graph-arrowhead";

const geometry = (fontSize) => ({
  fontSize,
  // A berth is a bar, not a box: the panel reads as track, and the ref and the
  // token hang beneath it the way a berth's identity does on a real diagram.
  berthWidth: fontSize * 7,
  berthHeight: fontSize * 0.85,
  slotGap: fontSize * 4, // between berths along one road (x) — crossovers land here
  roadPitch: fontSize * 5, // between roads (y) — holds the two label lines
  gutter: fontSize * 9, // road name, both ends, mirrored as on the comp
  padding: fontSize,
  arrowLength: fontSize * 1.1,
  arrowHeight: fontSize * 0.75,
  signalSize: fontSize * 0.85,
});

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

  const stride = options.berthWidth + options.slotGap;
  const positions = new Map();
  for (const node of orderedNodes) {
    positions.set(node.ref, {
      x: options.padding + options.gutter + (slots.get(node.ref) ?? 0) * stride,
      y:
        options.padding +
        (roadOf.get(node.bucket ?? "") ?? 0) * options.roadPitch,
      road: roadOf.get(node.bucket ?? "") ?? 0,
      slot: slots.get(node.ref) ?? 0,
    });
  }

  const lastSlot = positions.size
    ? Math.max(...[...positions.values()].map(({ slot }) => slot))
    : 0;
  const roads = roadNames.map((name, index) => ({
    name,
    index,
    y: options.padding + index * options.roadPitch + options.berthHeight / 2,
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
      options.padding +
        options.gutter +
        chosen * stride +
        options.berthWidth +
        options.slotGap / 2,
    );
  }

  // The road runs the full width whether or not a berth sits at the far end, so
  // the extent is the track's length, not the last berth's edge.
  const extent = {
    width:
      options.padding * 2 +
      options.gutter * 2 +
      (lastSlot + 1) * stride +
      options.slotGap,
    height:
      options.padding * 2 + Math.max(roadNames.length, 1) * options.roadPitch,
  };

  return { positions, roads, roadOf, slots, turns, cyclic, drawn, extent };
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
 * A crossover: horizontal run, 45-degree diagonal, horizontal run.
 *
 * The 45 is the whole discipline. A signalling diagram has exactly two angles,
 * and holding to them is what lets the eye follow one line across a field of
 * thirty others — a free-angle line between the same two points is a wire, and
 * a panel of wires is the node-graph editor this direction refuses.
 *
 * The diagonal's horizontal reach equals its vertical drop, so the leads are
 * whatever is left over, split evenly. When the gap is too narrow to fit the
 * drop at 45, the diagonal takes the whole span and the angle gives way rather
 * than the connection: a missing crossover is a lie about the plan, a steeper
 * one is only untidy.
 */
function crossoverPath(x1, y1, x2, y2, turnX) {
  const drop = Math.abs(y2 - y1);
  const span = x2 - x1;
  if (drop === 0) return `M ${trim(x1)},${trim(y1)} L ${trim(x2)},${trim(y2)}`;

  // The diagonal is centred on the reserved gap, so it changes roads in a
  // column no berth occupies. Clamped to the span so it never doubles back.
  const centre = Number.isFinite(turnX) ? turnX : x1 + span / 2;
  const start = Math.min(Math.max(centre - drop / 2, x1), x2 - drop);
  if (start < x1 || start + drop > x2) {
    return `M ${trim(x1)},${trim(y1)} L ${trim(x2)},${trim(y2)}`;
  }
  return [
    `M ${trim(x1)},${trim(y1)}`,
    `L ${trim(start)},${trim(y1)}`,
    `L ${trim(start + drop)},${trim(y2)}`,
    `L ${trim(x2)},${trim(y2)}`,
  ].join(" ");
}

/** A signal head: the post, and the lamp that carries the aspect. */
function signalHead(x, y, options, aspect) {
  const size = options.signalSize;
  return `<g class="graph-signal -${aspect}">
        <rect class="post" x="${trim(x - size / 2)}" y="${trim(y - size / 2)}" width="${trim(size)}" height="${trim(size)}" rx="2" ry="2" />
        <circle class="lamp" cx="${trim(x)}" cy="${trim(y)}" r="${trim(size / 4)}" />
      </g>`;
}

export function renderGraph(nodes, layout, opts = {}) {
  const { usage, ...geometryOpts } = opts;
  const options = resolve(geometryOpts);
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
        <line class="rail" stroke-width="${trim(options.berthHeight)}" x1="${trim(trackStart)}" y1="${trim(road.y)}" x2="${trim(trackEnd)}" y2="${trim(road.y)}" />
        <text class="graph-road-name -left" font-size="${options.fontSize * 0.8}" x="${trim(trackStart - options.fontSize * 0.75)}" y="${trim(road.y + options.fontSize * 0.3)}">${escapeHtml(road.name)}</text>
        <text class="graph-road-name -right" font-size="${options.fontSize * 0.8}" x="${trim(trackEnd + options.fontSize * 0.75)}" y="${trim(road.y + options.fontSize * 0.3)}">${escapeHtml(road.name)}</text>
      </g>`,
    )
    .join("");

  // Crossovers carry only the dependencies that leave their own road. A
  // dependency inside one bucket is already drawn — it is the road itself.
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
          `<path class="graph-crossover${dependency?.state === "done" ? " -cleared" : ""}" stroke-width="${trim(options.berthHeight)}" data-from="${escapeHtml(dependencyRef)}" data-to="${escapeHtml(node.ref)}" marker-end="url(#${ARROW_ID})" d="${crossoverPath(
            source.x + options.berthWidth,
            source.y + options.berthHeight / 2,
            target.x,
            target.y + options.berthHeight / 2,
            turns?.get(edgeKey(dependencyRef, node.ref)),
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
      const tokens = tokensByRef[node.ref]?.output;
      const tokenLine =
        tokenTier(tokens) === ""
          ? ""
          : `<text class="graph-tokens ${tokenTier(tokens)}" font-size="${options.fontSize * 0.75}" x="${trim(centreX)}" y="${trim(position.y + options.berthHeight + options.fontSize * 2.5)}">${escapeHtml(formatTokens(tokens))}</text>`;
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
        <text class="graph-ref" font-size="${options.fontSize * 0.85}" x="${trim(centreX)}" y="${trim(position.y + options.berthHeight + options.fontSize * 1.2)}">${escapeHtml(node.ref)}</text>
        ${tokenLine}
        ${isCyclic ? `<text class="graph-cycle-label" font-size="${options.fontSize * 0.7}" x="${trim(centreX)}" y="${trim(position.y - options.fontSize * 0.4)}">CYCLE</text>` : ""}
      </g>`,
      ];
    })
    .join("");

  const arrowDefs = crossovers
    ? `<defs><marker id="${ARROW_ID}" class="graph-arrow" markerUnits="userSpaceOnUse" markerWidth="${options.arrowLength}" markerHeight="${options.arrowHeight}" refX="${options.arrowLength}" refY="${options.arrowHeight / 2}" orient="auto"><path d="M 0 0 L ${options.arrowLength} ${options.arrowHeight / 2} L 0 ${options.arrowHeight} z" /></marker></defs>`
    : "";
  const empty = graphNodes.length
    ? ""
    : '<text class="graph-empty" x="50%" y="50%">No tasks in this flight tree.</text>';
  const cycleNote = cyclic.size
    ? `<text class="graph-cycle-note" x="${trim(width / 2)}" y="${trim(height - options.padding / 2)}">Cycle: ${escapeHtml([...cyclic].join(", "))}</text>`
    : "";

  return `<svg class="dependency-graph" width="${trim(width)}" height="${trim(height)}" viewBox="0 0 ${trim(width)} ${trim(height)}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Task dependency panel" xmlns="http://www.w3.org/2000/svg">${arrowDefs}${roadLines}${crossovers}${berths}${cycleNote}${empty}</svg>`;
}
