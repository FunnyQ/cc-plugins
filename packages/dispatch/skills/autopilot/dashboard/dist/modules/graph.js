import { escapeHtml } from "./format.js";

const DEFAULTS = {
  nodeWidth: 112,
  nodeHeight: 40,
  horizontalGap: 80,
  verticalGap: 64,
  padding: 8,
};

function compareNodes(left, right) {
  return (
    String(left.bucket ?? "").localeCompare(String(right.bucket ?? "")) ||
    String(left.nn ?? "").localeCompare(String(right.nn ?? ""), undefined, {
      numeric: true,
    }) ||
    String(left.ref).localeCompare(String(right.ref))
  );
}

export function layoutGraph(nodes, opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const orderedNodes = [...(Array.isArray(nodes) ? nodes : [])].sort(
    compareNodes,
  );
  const refs = new Set(orderedNodes.map(({ ref }) => ref));
  let depths = new Map();
  let stabilised = false;

  // A valid longest path settles within node count passes. The cap leaves
  // cycles and anything downstream of them visibly unsettled instead of hanging.
  for (let pass = 0; pass < orderedNodes.length; pass += 1) {
    const nextDepths = new Map(depths);

    for (const node of orderedNodes) {
      const dependencies = (node.dependsOn ?? []).filter((ref) =>
        refs.has(ref),
      );
      if (!dependencies.length) {
        nextDepths.set(node.ref, 0);
        continue;
      }

      const dependencyDepths = dependencies.map((ref) => depths.get(ref));
      if (dependencyDepths.every((depth) => depth !== undefined)) {
        nextDepths.set(node.ref, 1 + Math.max(...dependencyDepths));
      }
    }

    stabilised =
      nextDepths.size === orderedNodes.length &&
      nextDepths.size === depths.size &&
      [...nextDepths].every(([ref, depth]) => depths.get(ref) === depth);
    depths = nextDepths;
    if (stabilised) break;
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
    layerNodes.sort(compareNodes).forEach((node, index) => {
      positions.set(node.ref, {
        x:
          options.padding + index * (options.nodeWidth + options.horizontalGap),
        y: options.padding + depth * (options.nodeHeight + options.verticalGap),
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

        const x1 = source.x + options.nodeWidth / 2;
        const y1 = source.y + options.nodeHeight;
        const x2 = target.x + options.nodeWidth / 2;
        const y2 = target.y;
        const midpoint = y1 + (y2 - y1) / 2;
        const dimmed = dependency.state === "done" ? "" : " -dimmed";
        return [
          `<polyline class="graph-edge${dimmed}" points="${x1},${y1} ${x1},${midpoint} ${x2},${midpoint} ${x2},${y2}" />`,
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
      const labelY = position.y + (isCyclic ? 17 : 24);
      const cycleLabel = isCyclic
        ? `<text class="graph-cycle-label" x="${centreX}" y="${position.y + 31}">CYCLE</text>`
        : "";
      const statusDot =
        state === "in-progress"
          ? `<rect class="graph-status" x="${position.x + 6}" y="${position.y + 6}" width="6" height="6" rx="2" ry="2" />`
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
  return `<svg class="dependency-graph" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Task dependency graph" xmlns="http://www.w3.org/2000/svg">${edges}${renderedNodes}${cycleNote}${empty}</svg>`;
}
