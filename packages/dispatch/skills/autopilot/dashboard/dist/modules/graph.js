import { compareTaskOrder, escapeHtml } from "./format.js";

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
  nodeWidth: fontSize * 11,
  nodeHeight: fontSize * 3,
  horizontalGap: fontSize * 6, // between depth layers (x)
  verticalGap: fontSize * 2, // between siblings inside one layer (y)
  padding: fontSize / 2,
  arrowLength: fontSize * 1.1,
  arrowHeight: fontSize * 0.75,
});

const DEFAULTS = geometry(FONT_SIZE);

const resolve = (opts) => ({
  ...(opts.fontSize ? geometry(opts.fontSize) : DEFAULTS),
  ...opts,
});

// Refs are `bucket/NN-slug`, so no real task can collide with this.
const LANE_PREFIX = "lane:";

/**
 * Give every edge that skips a layer its own reserved row in each layer it
 * crosses.
 *
 * An edge drawn straight from its source to its target runs through whatever
 * happens to sit between them — measured on a real 30-task tree, 12 of 44 edges
 * crossed an intermediate node's box, one of them through six. No routing rule
 * fixes that, because the space the edge needs was never set aside.
 *
 * So a long edge becomes a chain: one placeholder per intermediate layer, each
 * occupying a row like any node. They sort with everything else, which is the
 * second win — a long edge previously had no say in how the layers it crossed
 * were ordered, and now it pulls on them like any other dependency.
 *
 * Mutates `layerGroups`, appending placeholders. Returns the chain per edge and
 * the node list ordering should run on: real nodes, but with a long dependency
 * rewritten to the placeholder that now feeds them.
 */
function reserveLanes(layerGroups, orderedNodes, depths, drawn) {
  const chains = new Map();
  const lanes = [];
  const rewritten = new Map(orderedNodes.map((node) => [node.ref, new Map()]));

  for (const key of drawn) {
    const [from, to] = key.split(EDGE_SEPARATOR);
    const start = depths.get(from);
    const end = depths.get(to);
    if (start === undefined || end === undefined || end - start <= 1) continue;

    const chain = [];
    let previous = from;
    for (let depth = start + 1; depth < end; depth += 1) {
      const ref = `${LANE_PREFIX}${key}#${depth}`;
      const lane = {
        ref,
        bucket: "",
        nn: "",
        dependsOn: [previous],
        lane: true,
      };
      lanes.push(lane);
      layerGroups.get(depth)?.push(lane);
      chain.push(ref);
      previous = ref;
    }
    chains.set(key, chain);
    // The target now answers to the last placeholder, not to the far-off source.
    rewritten.get(to)?.set(from, previous);
  }

  const orderingNodes = orderedNodes
    .map((node) => {
      const swaps = rewritten.get(node.ref);
      if (!swaps?.size) return node;
      return {
        ...node,
        dependsOn: (node.dependsOn ?? []).map((ref) => swaps.get(ref) ?? ref),
      };
    })
    .concat(lanes);

  return { chains, orderingNodes };
}

// Sweeps of the barycentre heuristic. Crossings drop fast over the first few
// and then stall, so a fixed count beats measuring: it is cheap, and it always
// terminates on a graph that would otherwise oscillate between two orderings.
const ORDER_PASSES = 6;

/**
 * Reorder each layer so edges run as straight across as they can.
 *
 * Sorting a layer by ref puts a node nowhere near its parents — `agent/01` lands
 * between `foundation/02`'s children purely because `a` sorts before `f` — and
 * every edge that has to reach past it becomes a crossing. Instead each node
 * takes the mean rank of its neighbours in the direction being swept, and the
 * layer sorts on that. Alternating the direction lets a node answer to both the
 * layer before it and the layer after.
 *
 * A node with no neighbour in the swept direction keeps its current rank, so it
 * drifts with the layer rather than collapsing to one end. Ties break on the
 * incoming order, which starts as ref order — so the layout is deterministic.
 *
 * Mutates `layerGroups` in place.
 */
function orderLayers(layerGroups, orderedNodes, refs) {
  const depths = [...layerGroups.keys()].sort((left, right) => left - right);
  if (depths.length < 2) return;

  const dependencies = new Map(
    orderedNodes.map((node) => [
      node.ref,
      (node.dependsOn ?? []).filter((ref) => refs.has(ref)),
    ]),
  );
  const dependents = new Map(orderedNodes.map((node) => [node.ref, []]));
  for (const [ref, deps] of dependencies) {
    for (const dep of deps) dependents.get(dep)?.push(ref);
  }

  const rank = new Map();
  const reindex = () => {
    for (const layerNodes of layerGroups.values()) {
      layerNodes.forEach((node, index) => rank.set(node.ref, index));
    }
  };
  reindex();

  for (let pass = 0; pass < ORDER_PASSES; pass += 1) {
    const forward = pass % 2 === 0;
    const neighbours = forward ? dependencies : dependents;
    const sweep = forward ? depths : [...depths].reverse();

    for (const depth of sweep) {
      const keyed = layerGroups.get(depth).map((node, index) => {
        const ranks = (neighbours.get(node.ref) ?? [])
          .map((ref) => rank.get(ref))
          .filter((value) => value !== undefined);
        return {
          node,
          index,
          barycentre: ranks.length
            ? ranks.reduce((sum, value) => sum + value, 0) / ranks.length
            : index,
        };
      });
      keyed.sort(
        (left, right) =>
          left.barycentre - right.barycentre || left.index - right.index,
      );
      layerGroups.set(
        depth,
        keyed.map(({ node }) => node),
      );
    }
    reindex();
  }
}

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

  const layerGroups = new Map();
  for (const node of orderedNodes) {
    const depth = depths.get(node.ref) ?? 0;
    if (!layerGroups.has(depth)) layerGroups.set(depth, []);
    layerGroups.get(depth).push(node);
  }
  // Ref order is the starting point and the tie-break, so the result is stable.
  for (const layerNodes of layerGroups.values())
    layerNodes.sort(compareTaskOrder);

  const drawn = drawableEdges(orderedNodes, new Set(cyclic));
  const { chains, orderingNodes } = reserveLanes(
    layerGroups,
    orderedNodes,
    depths,
    drawn,
  );
  orderLayers(
    layerGroups,
    orderingNodes,
    new Set(orderingNodes.map(({ ref }) => ref)),
  );

  // Centre each layer against the tallest. A layer laid out from the top makes
  // every edge into a short layer travel upward, which reads as structure that
  // isn't there.
  // A reserved row only has to hold a line, so it takes a thin pitch rather than
  // a node's. At a full row, 40 placeholders on a 30-task tree pushed 17 of them
  // below every real node and left a tall empty band under the graph.
  const rowPitch = options.nodeHeight + options.verticalGap;
  const lanePitch = options.fontSize;
  const pitchOf = (node) => (node.lane ? lanePitch : rowPitch);
  const heightOf = (layerNodes) =>
    layerNodes.reduce((total, node) => total + pitchOf(node), 0);
  const tallest = layerGroups.size
    ? Math.max(...[...layerGroups.values()].map(heightOf))
    : 0;

  const positions = new Map();
  const lanePositions = new Map();
  for (const [depth, layerNodes] of layerGroups) {
    const x = options.padding + depth * (options.nodeWidth + options.horizontalGap);
    let y = options.padding + (tallest - heightOf(layerNodes)) / 2;
    for (const node of layerNodes) {
      if (node.lane) {
        // Stored as the centre line: a lane is drawn along, not boxed by, its row.
        lanePositions.set(node.ref, { x, y: y + lanePitch / 2 });
      } else {
        positions.set(node.ref, { x, y });
      }
      y += pitchOf(node);
    }
  }

  // Reserved rows take up space like any other row, so the extent has to count
  // them. Measuring only the real nodes declares an SVG shorter than its own
  // content, and the container scrolls to the declared size — the rest is simply
  // unreachable.
  const extent = {
    width: Math.max(
      options.nodeWidth + options.padding * 2,
      ...[...positions.values(), ...lanePositions.values()].map(
        ({ x }) => x + options.nodeWidth + options.padding,
      ),
    ),
    height: Math.max(
      options.nodeHeight + options.padding * 2,
      ...[...positions.values()].map(
        ({ y }) => y + options.nodeHeight + options.padding,
      ),
      // A lane's y is its centre line, so only half a pitch sits below it.
      ...[...lanePositions.values()].map(
        ({ y }) => y + lanePitch / 2 + options.padding,
      ),
    ),
  };

  // A lane's reserved row becomes one horizontal run across that column, so the
  // edge is inside a slot nothing else can occupy.
  const waypoints = new Map();
  for (const [key, chain] of chains) {
    waypoints.set(
      key,
      chain.map((ref) => {
        const point = lanePositions.get(ref);
        return {
          left: point.x,
          right: point.x + options.nodeWidth,
          y: point.y,
        };
      }),
    );
  }

  return {
    positions,
    layers: layerGroups.size,
    cyclic,
    drawn,
    waypoints,
    extent,
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
 * Fan the gap crossings apart.
 *
 * A turn used to sit at the midpoint of the span — a property of the layer pair,
 * not of the edge — so every edge crossing a gap drew its vertical leg on the
 * same x, one directly over another. Edges sharing a gap now spread around that
 * midpoint, ordered by where they land so the fan does not cross itself.
 *
 * Mutates each segment, adding `fan`.
 */
function assignTurns(segments, options) {
  const gaps = new Map();
  for (const segment of segments) {
    const key = `${segment.x1}:${segment.x2}`;
    if (!gaps.has(key)) gaps.set(key, []);
    gaps.get(key).push(segment);
  }

  for (const group of gaps.values()) {
    group.sort((left, right) => left.y2 - right.y2 || left.y1 - right.y1);
    // Never let the fan reach a node edge: it stays inside 60% of the gap, so
    // even a heavily-shared crossing keeps its legs in open space.
    const step = Math.min(
      options.fontSize,
      (options.horizontalGap * 0.6) / group.length,
    );
    group.forEach((segment, index) => {
      segment.fan = (index - (group.length - 1) / 2) * step;
    });
  }
}

/**
 * The corners an edge turns, in order: its endpoints plus every reserved lane it
 * runs along, with a vertical inserted wherever consecutive runs sit at
 * different heights. Consecutive duplicates are dropped so a zero-length leg
 * never becomes a corner to round.
 */
function edgeVertices({ x1, y1, x2, y2, lanes = [], fan = 0 }) {
  const runs = [[x1, y1]];
  for (const lane of lanes) runs.push([lane.left, lane.y], [lane.right, lane.y]);
  runs.push([x2, y2]);

  const vertices = [runs[0]];
  for (const [x, y] of runs.slice(1)) {
    const [lastX, lastY] = vertices[vertices.length - 1];
    if (x === lastX && y === lastY) continue;
    if (y !== lastY) {
      const turn = lastX + (x - lastX) / 2 + fan;
      vertices.push([turn, lastY], [turn, y]);
    }
    vertices.push([x, y]);
  }
  return vertices;
}

/** An orthogonal vertex list as a path, every corner rounded. */
function roundedPath(vertices, radius) {
  if (vertices.length < 2) return "";

  const parts = [`M ${trim(vertices[0][0])},${trim(vertices[0][1])}`];
  for (let index = 1; index < vertices.length - 1; index += 1) {
    const [previousX, previousY] = vertices[index - 1];
    const [cornerX, cornerY] = vertices[index];
    const [nextX, nextY] = vertices[index + 1];
    const inLength = Math.hypot(cornerX - previousX, cornerY - previousY) || 1;
    const outLength = Math.hypot(nextX - cornerX, nextY - cornerY) || 1;
    // Half of the shorter leg is the ceiling: two corners sharing a leg can each
    // take their share without either overshooting the other.
    const reach = Math.min(radius, inLength / 2, outLength / 2);
    const inX = ((cornerX - previousX) / inLength) * reach;
    const inY = ((cornerY - previousY) / inLength) * reach;
    const outX = ((nextX - cornerX) / outLength) * reach;
    const outY = ((nextY - cornerY) / outLength) * reach;
    parts.push(
      `L ${trim(cornerX - inX)},${trim(cornerY - inY)}`,
      `Q ${trim(cornerX)},${trim(cornerY)} ${trim(cornerX + outX)},${trim(cornerY + outY)}`,
    );
  }
  const [lastX, lastY] = vertices[vertices.length - 1];
  parts.push(`L ${trim(lastX)},${trim(lastY)}`);
  return parts.join(" ");
}

/**
 * Spread where edges meet a node.
 *
 * Every edge used to attach at the node's vertical centre, so a node with four
 * incoming edges collapsed all four onto one pixel. Each side now shares its
 * height between the edges that use it, ordered by where they come from, so a
 * fan-in reads as a fan.
 *
 * Mutates each segment's `y1` / `y2`.
 */
function spreadAttachments(segments, options) {
  const sides = new Map();
  const add = (key, entry) => {
    if (!sides.has(key)) sides.set(key, []);
    sides.get(key).push(entry);
  };
  for (const segment of segments) {
    add(`out:${segment.from}`, { segment, end: "y1", toward: segment.y2 });
    add(`in:${segment.to}`, { segment, end: "y2", toward: segment.y1 });
  }

  for (const group of sides.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) => left.toward - right.toward);
    const centre = group[0].segment[group[0].end];
    // Inside the box, never past its corners — the arrowhead must still land on
    // the edge it points at.
    const usable = options.nodeHeight * 0.6;
    group.forEach((entry, index) => {
      entry.segment[entry.end] =
        centre + (index / (group.length - 1) - 0.5) * usable;
    });
  }
}

export function renderGraph(nodes, layout, opts = {}) {
  const options = resolve(opts);
  const graphNodes = Array.isArray(nodes) ? nodes : [];
  const positions = layout?.positions ?? new Map();
  const cyclic = new Set(layout?.cyclic ?? []);
  const nodeByRef = new Map(graphNodes.map((node) => [node.ref, node]));
  const positioned = [...positions.values()];
  // `layout.extent` already covers the reserved rows; the node sweep is the
  // fallback for a layout built before extents existed.
  const width = Math.max(
    options.nodeWidth + options.padding * 2,
    layout?.extent?.width ?? 0,
    ...positioned.map(({ x }) => x + options.nodeWidth + options.padding),
  );
  const graphHeight = Math.max(
    options.nodeHeight + options.padding * 2,
    layout?.extent?.height ?? 0,
    ...positioned.map(({ y }) => y + options.nodeHeight + options.padding),
  );
  const cycleNoteHeight = cyclic.size ? options.nodeHeight / 2 : 0;
  const height = graphHeight + cycleNoteHeight;

  // Reuse the layout's own reduction and lane plan: recomputing them here could
  // disagree with the rows it already reserved.
  const drawable = layout?.drawn ?? drawableEdges(graphNodes, cyclic);
  const waypoints = layout?.waypoints ?? new Map();
  const segments = graphNodes.flatMap((node) => {
    const target = positions.get(node.ref);
    if (!target) return [];

    return (node.dependsOn ?? []).flatMap((dependencyRef) => {
      const key = edgeKey(dependencyRef, node.ref);
      if (!drawable.has(key)) return [];
      const source = positions.get(dependencyRef);
      const dependency = nodeByRef.get(dependencyRef);
      if (!source || !dependency) return [];

      return [
        {
          from: dependencyRef,
          to: node.ref,
          dimmed: dependency.state === "done" ? "" : " -dimmed",
          x1: source.x + options.nodeWidth,
          y1: source.y + options.nodeHeight / 2,
          x2: target.x,
          y2: target.y + options.nodeHeight / 2,
          lanes: waypoints.get(key) ?? [],
        },
      ];
    });
  });

  spreadAttachments(segments, options);
  assignTurns(segments, options);

  const edges = segments
    .map(
      (segment) =>
        `<path class="graph-edge${segment.dimmed}" data-from="${escapeHtml(segment.from)}" data-to="${escapeHtml(segment.to)}" marker-end="url(#${ARROW_ID})" d="${roundedPath(edgeVertices(segment), options.fontSize / 2)}" />`,
    )
    .join("");

  const renderedNodes = graphNodes
    .flatMap((node) => {
      const position = positions.get(node.ref);
      if (!position) return [];

      const isCyclic = cyclic.has(node.ref);
      const hardFailed = node.latestScore?.hardFailed === true;
      const state = isCyclic ? "cyclic" : hardFailed ? "alert" : node.state;
      const centreX = position.x + options.nodeWidth / 2;
      // Baseline, not centre: nudge down by roughly a third of the cap height.
      const labelY =
        position.y +
        (isCyclic
          ? options.nodeHeight / 2 - options.fontSize * 0.35
          : options.nodeHeight / 2 + options.fontSize * 0.35);
      const cycleLabel = isCyclic
        ? `<text class="graph-cycle-label" font-size="${options.fontSize * 0.8}" x="${centreX}" y="${position.y + options.nodeHeight / 2 + options.fontSize}">CYCLE</text>`
        : "";
      const statusDot =
        state === "in-progress"
          ? `<rect class="graph-status" x="${position.x + options.fontSize / 2}" y="${position.y + options.fontSize / 2}" width="${options.fontSize / 2}" height="${options.fontSize / 2}" rx="2" ry="2" />`
          : "";
      return [
        `
      <g class="graph-node -${escapeHtml(state)}" data-ref="${escapeHtml(node.ref)}">
        <rect x="${position.x}" y="${position.y}" width="${options.nodeWidth}" height="${options.nodeHeight}" rx="4" ry="4" />
        ${statusDot}
        <text class="graph-ref" font-size="${options.fontSize}" x="${centreX}" y="${labelY}">${escapeHtml(node.ref)}</text>
        ${cycleLabel}
      </g>`,
      ];
    })
    .join("");

  // One shared marker, defined only when an edge references it — an unreferenced
  // <defs> would still parse, but an empty tree should render nothing but text.
  // markerUnits stays at strokeWidth so the head scales with the 2px edge; the
  // size itself is another multiple of the font, like every other measurement.
  // Slender, and measured in user space rather than stroke widths: tying the
  // head to the line weight made a squat triangle barely wider than the line
  // it capped, which read as a blob instead of an arrow. Length beats height
  // so the silhouette is a chevron, and the line meets it well behind the tip.
  const { arrowLength, arrowHeight } = options;
  const arrowDefs = edges
    ? `<defs><marker id="${ARROW_ID}" class="graph-arrow" markerUnits="userSpaceOnUse" markerWidth="${arrowLength}" markerHeight="${arrowHeight}" refX="${arrowLength}" refY="${arrowHeight / 2}" orient="auto"><path d="M 0 0 L ${arrowLength} ${arrowHeight / 2} L 0 ${arrowHeight} z" /></marker></defs>`
    : "";

  const empty = graphNodes.length
    ? ""
    : '<text class="graph-empty" x="50%" y="50%">No tasks in this flight tree.</text>';
  const cycleNote = cyclic.size
    ? `<text class="graph-cycle-note" x="${width / 2}" y="${height - options.padding}">Cycle: ${escapeHtml([...cyclic].join(", "))}</text>`
    : "";
  // The natural size ships with the SVG so a wide tree scrolls inside its
  // container instead of scaling every label down to unreadable.
  return `<svg class="dependency-graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Task dependency graph" xmlns="http://www.w3.org/2000/svg">${arrowDefs}${edges}${renderedNodes}${cycleNote}${empty}</svg>`;
}
