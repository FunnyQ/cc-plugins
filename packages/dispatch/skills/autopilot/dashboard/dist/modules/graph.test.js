import { describe, expect, test } from "bun:test";
import {
  drawableEdges,
  layoutGraph,
  relatedRefs,
  renderGraph,
} from "./graph.js";

function makeNode(ref, bucket, nn, dependsOn = []) {
  return {
    ref,
    bucket,
    nn,
    dependsOn,
    state: "ready",
  };
}

function compare(nodes) {
  return [...nodes]
    .sort((left, right) => left.bucket.localeCompare(right.bucket)
      || left.nn.localeCompare(right.nn, undefined, { numeric: true })
      || left.ref.localeCompare(right.ref))
    .map(({ ref }) => ref);
}

describe("layoutGraph", () => {
  test("lays out a linear chain left to right", () => {
    const nodes = [
      makeNode("A", "chain", "01"),
      makeNode("B", "chain", "02", ["A"]),
      makeNode("C", "chain", "03", ["B"]),
    ];
    const layout = layoutGraph(nodes);
    const secondLayout = layoutGraph(nodes);

    expect(layout.positions.get("A")).toEqual({ x: 7, y: 7 });
    expect(layout.positions.get("B")).toEqual({ x: 245, y: 7 });
    expect(layout.positions.get("C")).toEqual({ x: 483, y: 7 });
    expect(layout.positions.get("A").x).toBeLessThan(layout.positions.get("B").x);
    expect(layout.positions.get("B").x).toBeLessThan(layout.positions.get("C").x);
    expect([...secondLayout.positions]).toEqual([...layout.positions]);
    expect(secondLayout.cyclic).toEqual([]);
  });

  test("lays out a diamond with convergence at the deepest layer", () => {
    const nodes = [
      makeNode("D", "work", "04", ["B", "C"]),
      makeNode("C", "work", "03", ["A"]),
      makeNode("B", "work", "02", ["A"]),
      makeNode("A", "work", "01"),
    ];
    const layout = layoutGraph(nodes);
    const positionA = layout.positions.get("A");
    const positionB = layout.positions.get("B");
    const positionC = layout.positions.get("C");
    const positionD = layout.positions.get("D");

    expect(positionA.x).toBe(7);
    expect(positionB.x).toBe(245);
    expect(positionC.x).toBe(245);
    expect(positionD.x).toBe(483);
    expect(positionB.y).toBeLessThan(positionC.y);
    expect(compare(nodes.filter(({ ref }) => ref === "B" || ref === "C"))).toEqual(["B", "C"]);
  });

  test("places disconnected roots at the same depth in order", () => {
    const nodes = [
      makeNode("Y", "root", "02"),
      makeNode("X", "root", "01"),
    ];
    const layout = layoutGraph(nodes);

    expect(layout.positions.get("X").x).toBe(7);
    expect(layout.positions.get("Y").x).toBe(7);
    expect(layout.positions.get("X").y).toBeLessThan(layout.positions.get("Y").y);
    expect(compare(nodes)).toEqual(["X", "Y"]);
  });

  test("detects a two-node cycle without hanging", () => {
    const nodes = [
      makeNode("A", "cycle", "01", ["B"]),
      makeNode("B", "cycle", "02", ["A"]),
    ];
    const startedAt = performance.now();
    const layout = layoutGraph(nodes);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(50);
    expect(layout.cyclic).toEqual(["A", "B"]);
    expect(layout.positions.get("A").x).toBe(layout.positions.get("B").x);
    expect(layout.positions.get("A").y).toBeLessThan(layout.positions.get("B").y);
  });

  test("orders a layer top to bottom by bucket then numeric sequence", () => {
    const nodes = [
      makeNode("ui/10", "ui", "10"),
      makeNode("api/02", "api", "02"),
      makeNode("ui/02", "ui", "02"),
      makeNode("api/01", "api", "01"),
    ];
    const layout = layoutGraph(nodes);
    const positionedOrder = [...layout.positions]
      .sort(([, left], [, right]) => left.y - right.y)
      .map(([ref]) => ref);

    expect(positionedOrder).toEqual(compare(nodes));
    expect(positionedOrder).toEqual(["api/01", "api/02", "ui/02", "ui/10"]);
  });
});

describe("renderGraph", () => {
  test("renders positioned nodes and a dimmed dependency edge", () => {
    const nodes = [
      makeNode("A", "chain", "01"),
      makeNode("B", "chain", "02", ["A"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect(svg).toContain('<svg class="dependency-graph"');
    expect(svg).toContain('data-ref="A"');
    expect(svg).toContain('data-ref="B"');
    expect(svg.match(/<g class="graph-node/g)?.length).toBe(2);
    expect(svg.match(/<path class="graph-edge/g)?.length).toBe(1);
    expect(svg).toContain('class="graph-edge -dimmed"');
  });

  test("draws a dependency edge from the right edge into the left edge", () => {
    const nodes = [
      makeNode("A", "chain", "01"),
      makeNode("B", "chain", "02", ["A"]),
    ];
    const layout = layoutGraph(nodes);
    const svg = renderGraph(nodes, layout);
    const d = svg.match(/<path class="graph-edge[^>]* d="([^"]+)"/)[1];
    const coords = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(
      ([, x, y]) => [Number(x), Number(y)],
    );
    const [startX, startY] = coords[0];
    const [endX, endY] = coords[coords.length - 1];
    const source = layout.positions.get("A");
    const target = layout.positions.get("B");

    expect(startX).toBeGreaterThan(source.x);
    expect(startY).toBeGreaterThan(source.y);
    expect(startY).toBeLessThan(source.y + 42);
    expect(endX).toBe(target.x);
    expect(endY).toBe(startY);
  });

  test("marks cyclic nodes and lists their refs", () => {
    const nodes = [
      makeNode("A", "cycle", "01", ["B"]),
      makeNode("B", "cycle", "02", ["A"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect(svg.match(/>CYCLE<\/text>/g)?.length).toBe(2);
    expect(svg.match(/class="graph-node -cyclic"/g)?.length).toBe(2);
    expect(svg).toContain('class="graph-cycle-note"');
    expect(svg).toContain("Cycle: A, B");
  });
});

describe("renderGraph sizing", () => {
  test("carries its natural pixel size so a wide tree scrolls instead of shrinking", () => {
    const nodes = [
      makeNode("A", "chain", "01"),
      makeNode("B", "chain", "02", ["A"]),
      makeNode("C", "chain", "03", ["B"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));
    const viewBox = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);

    expect(svg).toContain(`width="${viewBox[1]}"`);
    expect(svg).toContain(`height="${viewBox[2]}"`);
    expect(Number(viewBox[1])).toBeGreaterThan(Number(viewBox[2]));
  });
});

describe("graph typography", () => {
  test("stamps a fixed font size on every label", () => {
    const nodes = [makeNode("chain/01", "chain", "01")];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect(svg).toContain('class="graph-ref" font-size="14"');
  });

  test("derives node geometry from that font size", () => {
    const nodes = [
      makeNode("A", "chain", "01"),
      makeNode("B", "chain", "02", ["A"]),
    ];
    const wide = layoutGraph(nodes, { fontSize: 28 });
    const normal = layoutGraph(nodes);

    // Double the type, double the box and the gaps that separate the boxes.
    expect(wide.positions.get("B").x - wide.positions.get("A").x).toBe(
      (normal.positions.get("B").x - normal.positions.get("A").x) * 2,
    );
  });

  test("a node is wide enough for a full bucket/NN ref", () => {
    const nodes = [makeNode("integration/01", "integration", "01")];
    const svg = renderGraph(nodes, layoutGraph(nodes));
    const width = Number(svg.match(/width="(\d+(?:\.\d+)?)"/)[1]);

    // 14 chars of 14px mono ≈ 118px, plus padding on both sides.
    expect(width).toBeGreaterThan(134);
  });
});

describe("edge arrows", () => {
  const chain = [
    makeNode("A", "chain", "01"),
    makeNode("B", "chain", "02", ["A"]),
  ];

  test("points every edge at its dependent", () => {
    const svg = renderGraph(chain, layoutGraph(chain));
    const markerId = svg.match(/<marker id="([^"]+)"/)[1];

    expect(svg).toContain(`marker-end="url(#${markerId})"`);
    expect(svg).toContain('orient="auto"');
  });

  test("sizes the arrow from the same font size as everything else", () => {
    const svg = renderGraph(chain, layoutGraph(chain), { fontSize: 28 });
    const normal = renderGraph(chain, layoutGraph(chain));
    const size = (markup) =>
      Number(markup.match(/<marker[^>]*markerWidth="(\d+(?:\.\d+)?)"/)[1]);

    expect(size(svg)).toBe(size(normal) * 2);
  });

  test("omits the marker definition when nothing connects", () => {
    const lone = [makeNode("A", "chain", "01")];
    const svg = renderGraph(lone, layoutGraph(lone));

    expect(svg).not.toContain("<marker");
    expect(svg).not.toContain("marker-end");
  });
});

describe("graph geometry overrides", () => {
  const chain = [
    makeNode("A", "chain", "01"),
    makeNode("B", "chain", "02", ["A"]),
  ];

  test("takes an explicit arrow size without touching the rest", () => {
    const svg = renderGraph(chain, layoutGraph(chain), {
      arrowLength: 40,
      arrowHeight: 24,
    });

    expect(svg).toContain('markerWidth="40"');
    expect(svg).toContain('markerHeight="24"');
    expect(svg).toContain('class="graph-ref" font-size="14"');
  });
});

describe("relatedRefs", () => {
  //  A ──→ B ──→ D        E is unrelated to the A/B/C/D lineage.
  //   └──→ C ──→ D
  const diamond = [
    makeNode("A", "work", "01"),
    makeNode("B", "work", "02", ["A"]),
    makeNode("C", "work", "03", ["A"]),
    makeNode("D", "work", "04", ["B", "C"]),
    makeNode("E", "side", "01"),
  ];

  test("takes the whole lineage in both directions", () => {
    expect([...relatedRefs(diamond, "B")].sort()).toEqual(["A", "B", "D"]);
  });

  test("a root reaches every descendant", () => {
    expect([...relatedRefs(diamond, "A")].sort()).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  test("a leaf reaches every ancestor", () => {
    expect([...relatedRefs(diamond, "D")].sort()).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  test("an isolated node is related only to itself", () => {
    expect([...relatedRefs(diamond, "E")]).toEqual(["E"]);
  });

  test("returns nothing for a ref that is not in the tree", () => {
    expect([...relatedRefs(diamond, "nope")]).toEqual([]);
  });

  test("terminates on a cycle", () => {
    const cyclic = [
      makeNode("A", "cycle", "01", ["B"]),
      makeNode("B", "cycle", "02", ["A"]),
    ];

    expect([...relatedRefs(cyclic, "A")].sort()).toEqual(["A", "B"]);
  });

  test("ignores a dependency on a node the tree does not contain", () => {
    const dangling = [makeNode("A", "work", "01", ["ghost/01"])];

    expect([...relatedRefs(dangling, "A")]).toEqual(["A"]);
  });
});

describe("edge identity", () => {
  test("each edge names the pair it connects", () => {
    const nodes = [
      makeNode("A", "chain", "01"),
      makeNode("B", "chain", "02", ["A"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect(svg).toContain('data-from="A"');
    expect(svg).toContain('data-to="B"');
  });
});

describe("drawable edges", () => {
  test("drops an edge another dependency already reaches", () => {
    // The shape lint-task.ts forces on every plan: the closing task names the
    // whole tree, so all but the nearest edge is implied by a path.
    const nodes = [
      makeNode("A", "core", "01"),
      makeNode("B", "core", "02", ["A"]),
      makeNode("C", "core", "03", ["A", "B"]),
    ];
    const drawn = drawableEdges(nodes);

    expect(drawn.has("B->C")).toBe(true);
    expect(drawn.has("A->B")).toBe(true);
    expect(drawn.has("A->C")).toBe(false);
  });

  test("keeps two dependencies that do not reach each other", () => {
    const nodes = [
      makeNode("A", "core", "01"),
      makeNode("B", "core", "02"),
      makeNode("C", "core", "03", ["A", "B"]),
    ];
    const drawn = drawableEdges(nodes);

    expect(drawn.has("A->C")).toBe(true);
    expect(drawn.has("B->C")).toBe(true);
  });

  test("keeps every edge touching a cyclic node", () => {
    // Inside a cycle each node reaches the others, so reduction would erase the
    // edges the reader most needs.
    const nodes = [
      makeNode("A", "core", "01", ["B"]),
      makeNode("B", "core", "02", ["A"]),
    ];
    const drawn = drawableEdges(nodes, new Set(["A", "B"]));

    expect(drawn.has("A->B")).toBe(true);
    expect(drawn.has("B->A")).toBe(true);
  });

  test("renderGraph omits the redundant edge", () => {
    const nodes = [
      makeNode("A", "core", "01"),
      makeNode("B", "core", "02", ["A"]),
      makeNode("C", "core", "03", ["A", "B"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect(svg).toContain('data-from="B" data-to="C"');
    expect(svg).not.toContain('data-from="A" data-to="C"');
  });
});

describe("svg extent", () => {
  test("declares a height that covers the reserved lane rows", () => {
    // A long edge reserves a row in each layer it crosses. Measuring only the
    // real nodes declared an SVG shorter than its own content, and the panel
    // scrolls to the declared size — everything past it was unreachable.
    // `X` is unreachable from the chain, so `X -> D` survives the reduction and
    // is the long edge that has to reserve rows.
    const nodes = [
      makeNode("A", "core", "01"),
      makeNode("B", "core", "02", ["A"]),
      makeNode("C", "core", "03", ["B"]),
      makeNode("D", "core", "04", ["C", "X"]),
      makeNode("X", "extra", "01"),
    ];
    const layout = layoutGraph(nodes);
    const svg = renderGraph(nodes, layout);
    const declared = Number(svg.match(/height="([\d.]+)"/)[1]);

    const lanes = [...layout.waypoints.values()].flat();
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) expect(declared).toBeGreaterThan(lane.y);
    for (const point of layout.positions.values()) {
      expect(declared).toBeGreaterThanOrEqual(point.y + 42);
    }
  });
});

describe("lane placement", () => {
  test("a chain longer than the sweep count still settles beside its edge", () => {
    // The barycentre sweep reindexes per layer, not per pass. Per pass, a
    // position advances only one layer per pass, so a placeholder chain longer
    // than ORDER_PASSES never hears where its edge starts and strands itself at
    // the bottom of every layer it crosses — placeholders are appended last.
    //
    // `X` sorts above the chain and is unreachable from it, so `X -> Z` survives
    // the reduction and every one of its eight placeholders belongs at the TOP
    // of its layer. Reaching that from the bottom is exactly the propagation the
    // per-layer reindex buys.
    const chain = Array.from({ length: 9 }, (_, index) =>
      makeNode(
        `A${index}`,
        "chain",
        String(index + 1).padStart(2, "0"),
        index === 0 ? [] : [`A${index - 1}`],
      ),
    );
    const nodes = [
      ...chain,
      makeNode("X", "aaa", "01"),
      makeNode("Z", "tail", "01", ["A8", "X"]),
    ];
    const layout = layoutGraph(nodes);
    const lanes = [...layout.waypoints.values()].flat();
    expect(lanes.length).toBe(8);

    // Every placeholder sits above the chain node sharing its column.
    const nodeAtColumn = new Map(
      [...layout.positions.values()].map(({ x, y }) => [x, y]),
    );
    for (const lane of lanes) {
      expect(lane.y).toBeLessThan(nodeAtColumn.get(lane.left));
    }
  });
});
