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

  test("the head stacks three lamps and stands clear of the rail", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
    ];
    const layout = layoutGraph(nodes);
    const svg = renderGraph(nodes, layout);

    // All three aspects are drawn; the CSS lights the one the group names.
    for (const aspect of ["clear", "caution", "danger"]) {
      expect(svg).toContain(`class="lamp -${aspect}"`);
    }

    // A head no taller than the track it sits on is invisible against it.
    const housing = Number(
      svg.match(/class="housing"[^>]*height="([\d.]+)"/)[1],
    );
    const rail = Number(svg.match(/class="rail" stroke-width="([\d.]+)"/)[1]);
    expect(housing).toBeGreaterThan(rail * 2);

    // And it must fit above the topmost road rather than clip off the panel.
    const top = Number(svg.match(/class="housing" x="[\d.]+" y="([\d.]+)"/)[1]);
    expect(top).toBeGreaterThanOrEqual(0);
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

describe("the running line inside a bucket", () => {
  test("links consecutive berths so a set route lights end to end", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
    ];
    const layout = layoutGraph(nodes);
    const svg = renderGraph(nodes, layout);

    expect(svg).toContain('data-from="api/01" data-to="api/02"');
    const link = svg.match(/class="graph-link"[^>]*>/)[0];
    // Berth edge to berth edge, so the lit route has no break in it.
    expect(Number(link.match(/x1="([\d.]+)"/)[1])).toBe(
      layout.positions.get("api/01").x + 14 * 7,
    );
    expect(Number(link.match(/x2="([\d.]+)"/)[1])).toBe(
      layout.positions.get("api/02").x,
    );
  });

  test("breaks at a berth the dependency reaches past", () => {
    // The real shape from docs/flightdeck: ui/04 depends on ui/02 and ui/03,
    // and ui/03 does not depend on ui/02 — so the reduction keeps ui/02 -> ui/04
    // and that edge spans ui/03's slot. Lighting straight through would put a
    // berth on the route that is on neither end of the lineage.
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("web/01", "web", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
      makeNode("api/03", "api", "03", ["web/01"]),
      makeNode("api/04", "api", "04", ["api/02", "api/03"]),
    ];
    const layout = layoutGraph(nodes);
    const svg = renderGraph(nodes, layout);

    const spanning = [
      ...svg.matchAll(
        /<line class="graph-link"[^>]*data-from="api\/02" data-to="api\/04"[^>]*>/g,
      ),
    ].map((match) => match[0]);
    expect(spanning.length).toBe(2);

    const blocker = layout.positions.get("api/03");
    const edges = spanning.map((line) => [
      Number(line.match(/x1="([\d.]+)"/)[1]),
      Number(line.match(/x2="([\d.]+)"/)[1]),
    ]);
    // Stops at the intervening berth, resumes past it, covers neither of it.
    expect(edges[0][1]).toBe(blocker.x);
    expect(edges[1][0]).toBe(blocker.x + 14 * 7);
    for (const [x1, x2] of edges) {
      expect(x2).toBeGreaterThan(x1);
    }
  });

  test("a dependency that leaves the bucket is a crossover, not a link", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("ui/01", "ui", "01", ["api/01"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect(svg).not.toContain("graph-link");
    expect(svg).toContain("graph-crossover");
  });
});

describe("berth seams", () => {
  test("each berth is closed at both ends so a lit run stays countable", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
    ];
    const layout = layoutGraph(nodes);
    const svg = renderGraph(nodes, layout);

    expect((svg.match(/class="graph-seam"/g) ?? []).length).toBe(4);
    for (const { x } of layout.positions.values()) {
      expect(svg).toContain(`class="graph-seam" x1="${x}"`);
      expect(svg).toContain(`class="graph-seam" x1="${x + 14 * 7}"`);
    }
  });
});

describe("panel tokens", () => {
  const nodes = [
    makeNode("api/01", "api", "01"),
    makeNode("api/02", "api", "02"),
  ];

  // A berth totals every agent on the task, so the per-agent tiers stay in the
  // fleet — the count here is drawn in one ink no matter how large.
  test("draws the count under the berth, untiered", () => {
    const svg = renderGraph(nodes, layoutGraph(nodes), {
      usage: { byTask: { "api/01": { output: 92_400 } } },
    });

    expect(svg).toContain('class="graph-tokens"');
    expect(svg).toContain(">92.4K</text>");
    expect(svg).not.toContain("-warn");
    expect(svg).not.toContain("-danger");
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

  describe("spreading into the pane", () => {
    const threeRoads = [
      makeNode("a/01", "a", "01"),
      makeNode("b/01", "b", "01"),
      makeNode("c/01", "c", "01"),
    ];
    const natural = layoutGraph(threeRoads).extent.height;

    test("roads spread to fill a taller pane", () => {
      const filled = layoutGraph(threeRoads, { availableHeight: 600 });

      expect(filled.extent.height).toBeGreaterThan(natural);
      // The gap between roads is what stretched, not the margins.
      expect(filled.roads[1].y - filled.roads[0].y).toBeGreaterThan(14 * 5);
      expect(filled.roads[0].y).toBe(layoutGraph(threeRoads).roads[0].y);
    });

    test("the spread stops at the cap rather than drifting apart", () => {
      const huge = layoutGraph(threeRoads, { availableHeight: 5_000 });

      expect(huge.roads[1].y - huge.roads[0].y).toBe(14 * 9);
    });

    test("a pane shorter than the panel never squeezes it", () => {
      const cramped = layoutGraph(threeRoads, { availableHeight: 40 });

      expect(cramped.extent.height).toBe(natural);
    });

    test("one road has nothing to spread", () => {
      const single = [makeNode("a/01", "a", "01")];

      expect(
        layoutGraph(single, { availableHeight: 5_000 }).extent.height,
      ).toBe(layoutGraph(single).extent.height);
    });
  });

  describe("fitting the pane's width", () => {
    // Six slots on one road: wide enough that the flat gutter and the natural
    // gap together overran a 1440 pane, which clipped the last berth's token.
    const oneRoad = [
      makeNode("contract/01", "contract", "01"),
      makeNode("contract/02", "contract", "02", ["contract/01"]),
      makeNode("contract/03", "contract", "03", ["contract/02"]),
      makeNode("contract/04", "contract", "04", ["contract/03"]),
      makeNode("contract/05", "contract", "05", ["contract/04"]),
      makeNode("contract/06", "contract", "06", ["contract/05"]),
    ];

    test("the gutter is the road name's own width, not a flat allowance", () => {
      const long = layoutGraph(oneRoad).geometry.gutter;
      const short = layoutGraph([makeNode("ui/01", "ui", "01")]).geometry
        .gutter;

      expect(long).toBeLessThan(14 * 9);
      expect(short).toBeLessThan(long);
      // Whole pixels: every berth's x is the gutter plus a multiple of the
      // stride, so a fractional gutter spreads float error across the panel.
      expect(Number.isInteger(long)).toBe(true);
    });

    test("gaps compress so the panel fits the pane", () => {
      const natural = layoutGraph(oneRoad);
      const fitted = layoutGraph(oneRoad, { availableWidth: 1_100 });

      expect(natural.extent.width).toBeGreaterThan(1_100);
      expect(fitted.extent.width).toBeLessThanOrEqual(1_100);
      expect(fitted.geometry.slotGap).toBeLessThan(natural.geometry.slotGap);
      // The berth itself never shrinks — it has to hold a full `bucket/NN`.
      const [first, second] = [...fitted.positions.values()];
      expect(second.x - first.x - 14 * 7).toBe(fitted.geometry.slotGap);
    });

    test("compression stops at the floor rather than crushing the gap", () => {
      const crushed = layoutGraph(oneRoad, { availableWidth: 120 });

      expect(crushed.geometry.slotGap).toBe(14 * 2.5);
      // Past the floor the panel simply overruns and the pane scrolls.
      expect(crushed.extent.width).toBeGreaterThan(120);
    });

    test("a pane wider than the panel never stretches it", () => {
      const roomy = layoutGraph(oneRoad, { availableWidth: 5_000 });

      expect(roomy.geometry.slotGap).toBe(14 * 4);
      expect(roomy.extent.width).toBe(layoutGraph(oneRoad).extent.width);
    });

    test("the render lands on the geometry the layout fitted", () => {
      const layout = layoutGraph(oneRoad, { availableWidth: 1_100 });
      const svg = renderGraph(oneRoad, layout);
      const railStart = Number(svg.match(/class="rail"[^>]*x1="([\d.]+)"/)[1]);
      const housing = Number(svg.match(/class="housing" x="([\d.]+)"/)[1]);
      const gated = [...layout.positions.values()][1];

      expect(railStart).toBe(14 + layout.geometry.gutter);
      // The head stands in the compressed gap, clear of the berth it gates.
      expect(housing).toBeGreaterThan(gated.x - layout.geometry.slotGap);
      expect(housing).toBeLessThan(gated.x);
    });
  });

  test("no arrowhead ships: a signalling panel has no arrows", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("ui/01", "ui", "01", ["api/01"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect(svg).toContain("graph-crossover");
    expect(svg).not.toContain("marker");
    expect(svg).not.toContain("<defs>");
  });
});
