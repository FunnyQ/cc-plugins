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
  test("lays out a linear chain at increasing depths", () => {
    const nodes = [
      makeNode("A", "chain", "01"),
      makeNode("B", "chain", "02", ["A"]),
      makeNode("C", "chain", "03", ["B"]),
    ];
    const layout = layoutGraph(nodes);
    const secondLayout = layoutGraph(nodes);

    expect(layout.positions.get("A")).toEqual({ x: 8, y: 8 });
    expect(layout.positions.get("B")).toEqual({ x: 8, y: 112 });
    expect(layout.positions.get("C")).toEqual({ x: 8, y: 216 });
    expect(layout.positions.get("A").y).toBeLessThan(layout.positions.get("B").y);
    expect(layout.positions.get("B").y).toBeLessThan(layout.positions.get("C").y);
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

    expect(positionA.y).toBe(8);
    expect(positionB.y).toBe(112);
    expect(positionC.y).toBe(112);
    expect(positionD.y).toBe(216);
    expect(positionB.x).toBeLessThan(positionC.x);
    expect(compare(nodes.filter(({ ref }) => ref === "B" || ref === "C"))).toEqual(["B", "C"]);
  });

  test("places disconnected roots at the same depth in order", () => {
    const nodes = [
      makeNode("Y", "root", "02"),
      makeNode("X", "root", "01"),
    ];
    const layout = layoutGraph(nodes);

    expect(layout.positions.get("X").y).toBe(8);
    expect(layout.positions.get("Y").y).toBe(8);
    expect(layout.positions.get("X").x).toBeLessThan(layout.positions.get("Y").x);
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
    expect(layout.positions.get("A").y).toBe(layout.positions.get("B").y);
    expect(layout.positions.get("A").x).toBeLessThan(layout.positions.get("B").x);
  });

  test("orders a layer by bucket then numeric sequence", () => {
    const nodes = [
      makeNode("ui/10", "ui", "10"),
      makeNode("api/02", "api", "02"),
      makeNode("ui/02", "ui", "02"),
      makeNode("api/01", "api", "01"),
    ];
    const layout = layoutGraph(nodes);
    const positionedOrder = [...layout.positions]
      .sort(([, left], [, right]) => left.x - right.x)
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
