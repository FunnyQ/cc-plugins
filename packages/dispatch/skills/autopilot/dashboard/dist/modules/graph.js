import { compareTaskOrder, escapeHtml } from "./format.js";

// Left-to-right layout: a dependency chain reads along the reading direction,
// and a wide node fits a full `bucket/NN` ref at a legible size instead of
// shrinking to fit a narrow column.
const DEFAULTS = {
  nodeWidth: 150,
  nodeHeight: 44,
  horizontalGap: 88, // between depth layers (x)
  verticalGap: 26, // between siblings inside one layer (y)
  padding: 8,
};

export function layoutGraph(nodes, opts = {}) {
  const options = { ...DEFAULTS, ...opts };
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
  const options = { ...DEFAULTS, ...opts };
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
          `<polyline class="graph-edge${dimmed}" points="${x1},${y1} ${midpoint},${y1} ${midpoint},${y2} ${x2},${y2}" />`,
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
      const labelY = position.y + (isCyclic ? 19 : options.nodeHeight / 2 + 5);
      const cycleLabel = isCyclic
        ? `<text class="graph-cycle-label" x="${centreX}" y="${position.y + 35}">CYCLE</text>`
        : "";
      const statusDot =
        state === "in-progress"
          ? `<rect class="graph-status" x="${position.x + 7}" y="${position.y + 7}" width="7" height="7" rx="2" ry="2" />`
          : "";
      return [
        `
      <g class="graph-node -${escapeHtml(state)}" data-ref="${escapeHtml(node.ref)}">
        <rect x="${position.x}" y="${position.y}" width="${options.nodeWidth}" height="${options.nodeHeight}" rx="4" ry="4" />
        ${statusDot}
        <text class="graph-ref" x="${centreX}" y="${labelY}">${escapeHtml(node.ref)}</text>
        ${cycleLabel}
      </g>`,
      ];
    })
    .join("");

  const empty = graphNodes.length
    ? ""
    : '<text class="graph-empty" x="50%" y="50%">No tasks in this flight tree.</text>';
  const cycleNote = cyclic.size
    ? `<text class="graph-cycle-note" x="${width / 2}" y="${height - options.padding}">Cycle: ${escapeHtml([...cyclic].join(", "))}</text>`
    : "";
  // The natural size ships with the SVG so a wide tree scrolls inside its
  // container instead of scaling every label down to unreadable.
  return `<svg class="dependency-graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Task dependency graph" xmlns="http://www.w3.org/2000/svg">${edges}${renderedNodes}${cycleNote}${empty}</svg>`;
}
