import { describe, expect, test } from "bun:test";
import { layoutGraph, renderGraph } from "./graph.js";

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
    expect(svg.match(/<polyline /g)?.length).toBe(1);
    expect(svg).toContain('class="graph-edge -dimmed"');
  });

  test("draws a dependency edge from the right edge into the left edge", () => {
    const nodes = [
      makeNode("A", "chain", "01"),
      makeNode("B", "chain", "02", ["A"]),
    ];
    const layout = layoutGraph(nodes);
    const svg = renderGraph(nodes, layout);
    const points = svg.match(/points="([^"]+)"/)[1].split(" ");
    const [startX, startY] = points[0].split(",").map(Number);
    const [endX, endY] = points[points.length - 1].split(",").map(Number);
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
