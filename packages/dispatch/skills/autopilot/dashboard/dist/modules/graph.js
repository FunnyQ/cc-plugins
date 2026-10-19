import {
  allHarnessTokens,
  compareTaskOrder,
  escapeHtml,
  formatDuration,
  formatTokens,
  hasTokenReading,
} from "./format.js";

const FONT_SIZE = 14;

const MONO_ADVANCE = 0.6;
const ROAD_NAME_SCALE = 0.8;
const REF_SCALE = 0.85;
const TOKEN_SCALE = 0.75;
const FLOW_SCALE = 0.45;

const advance = (characters, scale, fontSize) =>
  characters * fontSize * scale * MONO_ADVANCE;

const geometry = (fontSize) => ({
  fontSize,
  berthLineGap: fontSize * 0.35,
  berthPadY: fontSize * 0.55,
  berthHeight: Math.round(
    fontSize * (REF_SCALE + TOKEN_SCALE) + fontSize * 0.35 + fontSize * 1.1,
  ),
  berthPadX: fontSize * 0.55,
  statusWidth: fontSize * 0.3, // the lit leading edge
  refGap: fontSize * 0.9, // between the two figures on the plate's second line
  minBerthWidth: fontSize * 7, // never narrower than the bar it replaced
  railWidth: fontSize * 0.85,
  slotGap: fontSize * 6, // between berths along one road (x) — crossovers land here
  roadPitch: fontSize * 5, // between roads (y)
  maxRoadPitch: fontSize * 9,
  gutter: fontSize * 9, // road name, both ends, mirrored as on the comp — a cap
  minGutter: fontSize * 2,
  minSlotGap: fontSize * 4,
  padding: fontSize,
  signalWidth: fontSize * 1.25,
  signalHeight: fontSize * 4,
  signalLamp: fontSize * 0.34,
  crossoverEase: 0.5,
});

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

const TOKEN_COLUMNS = 6;
const ELAPSED_COLUMNS = 7;

const berthWidthFor = (nodes, options) => {
  const longest = Math.max(
    0,
    ...nodes.map(({ ref }) => String(ref ?? "").length),
  );
  const refLine = advance(longest, REF_SCALE, options.fontSize);
  const figureLine =
    advance(TOKEN_COLUMNS, TOKEN_SCALE, options.fontSize) +
    options.refGap +
    advance(ELAPSED_COLUMNS, TOKEN_SCALE, options.fontSize);

  return Math.round(
    Math.max(
      options.minBerthWidth,
      options.statusWidth +
        options.berthPadX * 2 +
        Math.max(refLine, figureLine),
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

  const roadNames = options.lanes?.length ? [...options.lanes] : [];
  const roadOf = new Map(roadNames.map((name, index) => [name, index]));
  for (const node of options.lanes?.length && Array.isArray(nodes)
    ? nodes
    : orderedNodes) {
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
   *
   * The packing has to settle across roads, not once per road. A berth pushed
   * right to clear its own road is now right of where its dependents' depths
   * expected it, and a single pass leaves those dependents where they were — so
   * the crossover between them runs right-to-left and the panel says a task is
   * waiting on something downstream of it. On the tree that found this,
   * `api/08` packed from depth 5 to slot 7 while `studio/02` stayed at slot 6,
   * and the route it depends on came back up the pane. So a berth also takes a
   * slot past every dependency's slot, and the two constraints are run to a
   * fixed point. It settles for the same reason the depth pass does: both only
   * ever move a berth right, and together they form a DAG once the cycles are
   * held out — a dependency edge raises the depth, a road edge never lowers it,
   * so no chain of the two returns to where it started.
   *
   * A cyclic node is exempt from the dependency floor. Inside a cycle each node
   * demands a slot past the others, which no arrangement satisfies; they already
   * share the one column past the settled graph.
   */
  const roadOrder = new Map(
    roadNames.map((road) => [
      road,
      orderedNodes
        .filter((node) => (node.bucket ?? "") === road)
        .sort(
          (left, right) =>
            (depths.get(left.ref) ?? 0) - (depths.get(right.ref) ?? 0) ||
            compareTaskOrder(left, right),
        ),
    ]),
  );
  const cyclicRefs = new Set(cyclic);
  const slots = new Map();

  for (let pass = 0; pass < orderedNodes.length; pass += 1) {
    let changed = false;

    for (const road of roadNames) {
      let previous = -1;
      for (const node of roadOrder.get(road) ?? []) {
        const floors = cyclicRefs.has(node.ref)
          ? []
          : (node.dependsOn ?? [])
              .filter((ref) => refs.has(ref) && !cyclicRefs.has(ref))
              .map((ref) => (slots.get(ref) ?? 0) + 1);
        const slot = Math.max(
          depths.get(node.ref) ?? 0,
          previous + 1,
          ...floors,
        );

        if (slots.get(node.ref) !== slot) {
          slots.set(node.ref, slot);
          changed = true;
        }
        previous = slot;
      }
    }

    if (!changed) break;
  }

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
    turns.set(
      key,
      options.padding + gutter + chosen * stride + berthWidth + slotGap / 2,
    );
  }

  const extent = {
    width: options.padding * 2 + gutter * 2 + (lastSlot + 1) * stride + slotGap,
    height: headroom + (roadCount - 1) * roadPitch + footroom,
  };

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

  const width = Math.min(reach, span);
  if (!(width > 0)) {
    return `M ${trim(x1)},${trim(y1)} L ${trim(x2)},${trim(y2)}`;
  }

  const centre = Number.isFinite(turnX) ? turnX : x1 + span / 2;
  const start = Math.min(Math.max(centre - width / 2, x1), x2 - width);

  const bend = width * Math.min(Math.max(ease, 0), 1);
  return [
    `M ${trim(x1)},${trim(y1)}`,
    `L ${trim(start)},${trim(y1)}`,
    `C ${trim(start + bend)},${trim(y1)} ${trim(start + width - bend)},${trim(y2)} ${trim(start + width)},${trim(y2)}`,
    `L ${trim(x2)},${trim(y2)}`,
  ].join(" ");
}

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
  const { usage, elapsed: elapsedByRef = {}, ...geometryOpts } = opts;
  const options = { ...resolve(geometryOpts), ...(layout.geometry ?? {}) };
  const tokensByRef = usage?.byTask ?? {};
  const codexByRef = usage?.codexByTask ?? {};
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

  const roadLines = roads
    .map(
      (road) => `<g class="graph-road" data-road="${escapeHtml(road.name)}">
        <line class="rail" stroke-width="${trim(options.railWidth)}" x1="${trim(trackStart)}" y1="${trim(road.y)}" x2="${trim(trackEnd)}" y2="${trim(road.y)}" />
        <text class="graph-road-name -left" font-size="${options.fontSize * ROAD_NAME_SCALE}" x="${trim(trackStart - options.fontSize * 0.75)}" y="${trim(road.y + options.fontSize * 0.3)}">${escapeHtml(road.name)}</text>
        <text class="graph-road-name -right" font-size="${options.fontSize * ROAD_NAME_SCALE}" x="${trim(trackEnd + options.fontSize * 0.75)}" y="${trim(road.y + options.fontSize * 0.3)}">${escapeHtml(road.name)}</text>
      </g>`,
    )
    .join("");

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

        return spans.map(([x1, x2]) => {
          const geometry = `x1="${trim(x1)}" y1="${trim(y)}" x2="${trim(x2)}" y2="${trim(y)}"`;
          const edge = `data-from="${escapeHtml(dependencyRef)}" data-to="${escapeHtml(node.ref)}"`;
          return (
            `<line class="graph-link" stroke-width="${trim(options.railWidth)}" ${edge} ${geometry} />` +
            `<line class="graph-flow" stroke-width="${trim(options.railWidth * FLOW_SCALE)}" ${edge} ${geometry} />`
          );
        });
      });
    })
    .join("");

  const crossovers = graphNodes
    .flatMap((node) => {
      const target = positions.get(node.ref);
      if (!target) return [];
      return (node.dependsOn ?? []).flatMap((dependencyRef) => {
        if (!drawn.has(edgeKey(dependencyRef, node.ref))) return [];
        const source = positions.get(dependencyRef);
        if (!source || source.road === target.road) return [];
        const dependency = graphNodes.find((n) => n.ref === dependencyRef);
        const d = crossoverPath(
          source.x + options.berthWidth,
          source.y + options.berthHeight / 2,
          target.x,
          target.y + options.berthHeight / 2,
          turns?.get(edgeKey(dependencyRef, node.ref)),
          { ease: options.crossoverEase, reach: options.slotGap },
        );
        const edge = `data-from="${escapeHtml(dependencyRef)}" data-to="${escapeHtml(node.ref)}"`;
        return [
          `<path class="graph-crossover${dependency?.state === "done" ? " -cleared" : ""}" stroke-width="${trim(options.railWidth)}" ${edge} d="${d}" />` +
            `<path class="graph-flow" stroke-width="${trim(options.railWidth * FLOW_SCALE)}" ${edge} d="${d}" />`,
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
      /*
       * Two baselines, derived from the block the two lines make rather than
       * picked. Each line sits on its own visual centre, and the pair is
       * centred on the plate — so the block stays centred if either type scale
       * or the line gap moves.
       *
       * The 0.35-of-type-size drop off a line's centre is the same trick the
       * single-line plate used: it puts the x-height band on that centre, which
       * is where the eye reads it. A raw baseline hangs the whole word above.
       */
      const refHeight = options.fontSize * REF_SCALE;
      const figureHeight = options.fontSize * TOKEN_SCALE;
      const blockTop =
        midY - (refHeight + options.berthLineGap + figureHeight) / 2;
      const refY = blockTop + refHeight / 2 + refHeight * 0.35;
      const figureY =
        blockTop +
        refHeight +
        options.berthLineGap +
        figureHeight / 2 +
        figureHeight * 0.35;
      const claudeCounts = tokensByRef[node.ref];
      const codexCounts = codexByRef[node.ref];
      const tokens =
        claudeCounts === undefined && codexCounts === undefined
          ? undefined
          : allHarnessTokens(claudeCounts, codexCounts);
      const tokenLine = !hasTokenReading(tokens)
        ? ""
        : `<text class="graph-tokens" font-size="${options.fontSize * TOKEN_SCALE}" x="${trim(position.x + options.statusWidth + options.berthPadX)}" y="${trim(figureY)}">${escapeHtml(formatTokens(tokens))}</text>`;
      const elapsed = elapsedByRef[node.ref];
      const elapsedLine = !elapsed
        ? ""
        : `<text class="graph-elapsed"${elapsed.live ? ` data-elapsed-since="${trim(elapsed.startMs)}"` : ""} font-size="${options.fontSize * TOKEN_SCALE}" x="${trim(position.x + options.berthWidth - options.berthPadX)}" y="${trim(figureY)}">${escapeHtml(formatDuration(elapsed.ms))}</text>`;
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
        <text class="graph-ref" font-size="${options.fontSize * REF_SCALE}" x="${trim(position.x + options.statusWidth + options.berthPadX)}" y="${trim(refY)}">${escapeHtml(node.ref)}</text>
        ${tokenLine}
        ${elapsedLine}
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
