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

  const layerGroups = new Map();
  for (const node of orderedNodes) {
    const depth = depths.get(node.ref) ?? 0;
    if (!layerGroups.has(depth)) layerGroups.set(depth, []);
    layerGroups.get(depth).push(node);
  }

  const positions = new Map();
  for (const [depth, layerNodes] of layerGroups) {
    layerNodes.sort(compareTaskOrder).forEach((node, index) => {
      positions.set(node.ref, {
        x:
          options.padding + depth * (options.nodeWidth + options.horizontalGap),
        y:
          options.padding + index * (options.nodeHeight + options.verticalGap),
      });
    });
  }

  return {
    positions,
    layers: layerGroups.size,
    cyclic,
  };
}

export function renderGraph(nodes, layout, opts = {}) {
  const options = resolve(opts);
  const graphNodes = Array.isArray(nodes) ? nodes : [];
  const positions = layout?.positions ?? new Map();
  const cyclic = new Set(layout?.cyclic ?? []);
  const nodeByRef = new Map(graphNodes.map((node) => [node.ref, node]));
  const positioned = [...positions.values()];
  const width = Math.max(
    options.nodeWidth + options.padding * 2,
    ...positioned.map(({ x }) => x + options.nodeWidth + options.padding),
  );
  const graphHeight = Math.max(
    options.nodeHeight + options.padding * 2,
    ...positioned.map(({ y }) => y + options.nodeHeight + options.padding),
  );
  const cycleNoteHeight = cyclic.size ? options.nodeHeight / 2 : 0;
  const height = graphHeight + cycleNoteHeight;

  const edges = graphNodes
    .flatMap((node) => {
      const target = positions.get(node.ref);
      if (!target) return [];

      return (node.dependsOn ?? []).flatMap((dependencyRef) => {
        const source = positions.get(dependencyRef);
        const dependency = nodeByRef.get(dependencyRef);
        if (!source || !dependency) return [];

        const x1 = source.x + options.nodeWidth;
        const y1 = source.y + options.nodeHeight / 2;
        const x2 = target.x;
        const y2 = target.y + options.nodeHeight / 2;
        const midpoint = x1 + (x2 - x1) / 2;
        const dimmed = dependency.state === "done" ? "" : " -dimmed";
        return [
          `<polyline class="graph-edge${dimmed}" marker-end="url(#${ARROW_ID})" points="${x1},${y1} ${midpoint},${y1} ${midpoint},${y2} ${x2},${y2}" />`,
        ];
      });
    })
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
  const arrowLength = options.fontSize * 1.1;
  const arrowHeight = options.fontSize * 0.75;
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
