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
    .sort(
      (left, right) =>
        left.bucket.localeCompare(right.bucket) ||
        left.nn.localeCompare(right.nn, undefined, { numeric: true }) ||
        left.ref.localeCompare(right.ref),
    )
    .map(({ ref }) => ref);
}

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
    expect([...relatedRefs(diamond, "A")].sort()).toEqual(["A", "B", "C", "D"]);
  });

  test("a leaf reaches every ancestor", () => {
    expect([...relatedRefs(diamond, "D")].sort()).toEqual(["A", "B", "C", "D"]);
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
  // Cross-bucket, because only a dependency that leaves its own road is drawn
  // as a crossover; one inside a bucket is the running road itself.
  test("each crossover names the pair it connects", () => {
    const nodes = [
      makeNode("A", "one", "01"),
      makeNode("B", "two", "01", ["A"]),
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

  // C sits on its own road so both surviving dependencies become crossovers and
  // the reduction is visible in the markup.
  test("renderGraph omits the redundant edge", () => {
    const nodes = [
      makeNode("A", "core", "01"),
      makeNode("B", "core", "02", ["A"]),
      makeNode("C", "tail", "01", ["A", "B"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect(svg).toContain('data-from="B" data-to="C"');
    expect(svg).not.toContain('data-from="A" data-to="C"');
  });
});

describe("roads and berths", () => {
  test("one road per bucket, in the order the tasks arrive", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("ui/01", "ui", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
    ];
    const layout = layoutGraph(nodes);

    expect(layout.roads.map(({ name }) => name)).toEqual(["api", "ui"]);
    expect(layout.positions.get("api/01").road).toBe(
      layout.positions.get("api/02").road,
    );
    expect(layout.positions.get("ui/01").road).not.toBe(
      layout.positions.get("api/01").road,
    );
  });

  test("a task never leaves its bucket's line", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("ui/01", "ui", "01", ["api/01"]),
      makeNode("ui/02", "ui", "02", ["ui/01"]),
    ];
    const layout = layoutGraph(nodes);

    expect(layout.positions.get("ui/01").y).toBe(
      layout.positions.get("ui/02").y,
    );
  });

  test("two tasks of one bucket at the same depth take different slots", () => {
    // Both are roots, so both sit at depth 0; on one road that would be two
    // berths in one block, and the second would hide the first.
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02"),
    ];
    const layout = layoutGraph(nodes);

    expect(layout.positions.get("api/01").slot).toBe(0);
    expect(layout.positions.get("api/02").slot).toBe(1);
  });

  test("a road runs strictly left to right", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02"),
      makeNode("api/03", "api", "03", ["api/01"]),
    ];
    const layout = layoutGraph(nodes);
    const slots = ["api/01", "api/02", "api/03"].map(
      (ref) => layout.positions.get(ref).slot,
    );

    expect(slots).toEqual([...slots].sort((a, b) => a - b));
    expect(new Set(slots).size).toBe(slots.length);
  });

  test("renders the road name in both gutters", () => {
    const nodes = [makeNode("api/01", "api", "01")];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect(svg).toContain('class="graph-road-name -left"');
    expect(svg).toContain('class="graph-road-name -right"');
    expect((svg.match(/>api<\/text>/g) ?? []).length).toBe(2);
  });

  test("a dependency inside one bucket draws no crossover", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect(svg).not.toContain("graph-crossover");
  });
});

describe("crossover routing", () => {
  // The regression this suite exists for: contract/02 -> server/04 drove its
  // diagonal straight through server/03's segment on the first render.
  // b/03 sits two slots along, so the span is wide enough to hold the drop at
  // 45 degrees. A crossover with no room falls back to a straight line by
  // design — the connection matters more than the angle.
  const nodes = [
    makeNode("a/01", "a", "01"),
    makeNode("b/01", "b", "01"),
    makeNode("b/02", "b", "02", ["b/01"]),
    makeNode("b/03", "b", "03", ["a/01"]),
  ];

  test("changes road inside a gap, never over another berth", () => {
    const layout = layoutGraph(nodes);
    const turnX = layout.turns.get("a/01->b/03");
    const options = { berthWidth: 14 * 7, slotGap: 14 * 4 };

    expect(turnX).toBeGreaterThan(0);
    for (const [ref, p] of layout.positions) {
      if (ref === "a/01" || ref === "b/03") continue;
      const covers = turnX > p.x && turnX < p.x + options.berthWidth;
      expect(covers).toBe(false);
    }
  });

  test("holds 45 degrees: the diagonal's run equals its drop", () => {
    const layout = layoutGraph(nodes);
    const svg = renderGraph(nodes, layout);
    const d = svg.match(/data-from="a\/01" data-to="b\/03"[^>]*d="([^"]+)"/)[1];
    const pts = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(([, x, y]) => [
      Number(x),
      Number(y),
    ]);

    expect(pts.length).toBe(4);
    const [, [x2, y2], [x3, y3]] = pts;
    expect(Math.abs(x3 - x2)).toBeCloseTo(Math.abs(y3 - y2), 5);
  });
});

describe("signals", () => {
  test("a berth with a dependency carries a signal head", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect((svg.match(/class="graph-signal/g) ?? []).length).toBe(1);
  });

  test("the aspect follows the task's state", () => {
    const done = {
      ...makeNode("api/02", "api", "02", ["api/01"]),
      state: "done",
    };
    const blocked = {
      ...makeNode("api/02", "api", "02", ["api/01"]),
      state: "blocked",
    };
    const root = makeNode("api/01", "api", "01");

    expect(renderGraph([root, done], layoutGraph([root, done]))).toContain(
      "graph-signal -clear",
    );
    expect(
      renderGraph([root, blocked], layoutGraph([root, blocked])),
    ).toContain("graph-signal -danger");
  });
});

describe("panel tokens", () => {
  const nodes = [
    makeNode("api/01", "api", "01"),
    makeNode("api/02", "api", "02"),
  ];

  test("tiers the count under the berth", () => {
    const svg = renderGraph(nodes, layoutGraph(nodes), {
      usage: { byTask: { "api/01": { output: 92_400 } } },
    });

    expect(svg).toContain('class="graph-tokens -warn"');
    expect(svg).toContain(">92.4K</text>");
  });

  test("omits the line where nothing was measured, and draws no pill", () => {
    const svg = renderGraph(nodes, layoutGraph(nodes), {
      usage: { byTask: {} },
    });

    expect(svg).not.toContain("graph-tokens");
    expect(svg).not.toContain("graph-token-pill");
    expect(svg).not.toContain("N/A");
  });
});

describe("panel extent", () => {
  test("the road runs the full declared width", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));
    const width = Number(svg.match(/width="([\d.]+)"/)[1]);
    const railEnd = Number(svg.match(/class="rail"[^>]*x2="([\d.]+)"/)[1]);

    expect(railEnd).toBeLessThan(width);
    expect(railEnd).toBeGreaterThan(width * 0.7);
  });

  test("height grows one pitch per road", () => {
    const one = layoutGraph([makeNode("a/01", "a", "01")]);
    const three = layoutGraph([
      makeNode("a/01", "a", "01"),
      makeNode("b/01", "b", "01"),
      makeNode("c/01", "c", "01"),
    ]);

    expect(three.extent.height - one.extent.height).toBe(2 * 14 * 5);
  });
});
