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

describe("declared roads", () => {
  const nodes = [
    makeNode("verify/02", "verify", "02"),
    makeNode("scout/01", "scout", "01"),
    makeNode("verify/01", "verify", "01"),
  ];

  test("preserves declared order, including empty roads", () => {
    const lanes = ["verify", "build", "scout"];
    const layout = layoutGraph(nodes, { lanes });

    expect(layout.roads.map(({ name }) => name)).toEqual(lanes);
    expect([...layout.roadOf]).toEqual([
      ["verify", 0],
      ["build", 1],
      ["scout", 2],
    ]);
    expect(
      [...layout.positions.values()].filter(({ road }) => road === 1),
    ).toEqual([]);
    expect(layout.extent.height).toBeGreaterThan(
      layoutGraph(nodes).extent.height,
    );
    const svg = renderGraph(nodes, layout);
    expect(
      [...svg.matchAll(/class="graph-road" data-road="([^"]+)"/g)].map(
        (match) => match[1],
      ),
    ).toEqual(lanes);
    expect(svg).toMatch(/data-road="build">\s*<line class="rail"/);
    expect(svg.match(/>build<\/text>/g)).toHaveLength(2);
  });

  test("appends undeclared buckets in input order", () => {
    const layout = layoutGraph(nodes, { lanes: ["build"] });
    expect(layout.roads.map(({ name }) => name)).toEqual([
      "build",
      "verify",
      "scout",
    ]);
    expect([...layout.positions.keys()]).toEqual(compare(nodes));
    expect(layout.positions.get("verify/01").road).toBe(1);
    expect(layout.positions.get("scout/01").road).toBe(2);
  });

  test("draws declared roads before any nodes arrive", () => {
    const lanes = ["scout", "build", "verify"];
    const layout = layoutGraph([], { lanes });
    expect(layout.roads.map(({ name }) => name)).toEqual(lanes);
    expect([...layout.positions]).toEqual([]);
    expect(renderGraph([], layout).match(/class="graph-road"/g)).toHaveLength(
      3,
    );
  });

  test("keeps duplicate declarations verbatim", () => {
    const lanes = ["verify", "build", "verify", "scout"];
    expect(layoutGraph(nodes, { lanes }).roads.map(({ name }) => name)).toEqual(
      lanes,
    );
  });

  test("keeps the existing layout when lanes are absent or empty", () => {
    const baseline = layoutGraph(nodes);
    expect(baseline.roads.map(({ name }) => name)).toEqual(["scout", "verify"]);
    expect([...baseline.slots]).toEqual([
      ["scout/01", 0],
      ["verify/01", 0],
      ["verify/02", 1],
    ]);
    expect(layoutGraph(nodes, { lanes: [] })).toEqual(baseline);
    expect(layoutGraph([...nodes].reverse())).toEqual(baseline);
  });

  test("keeps task ordering within each road", () => {
    const layout = layoutGraph(nodes, { lanes: ["verify", "scout"] });
    expect([...layout.positions.keys()]).toEqual(compare(nodes));
    expect(nodes.map(({ ref }) => layout.slots.get(ref))).toEqual(
      nodes.map(({ ref }) => layoutGraph(nodes).slots.get(ref)),
    );
  });
});

test("the app uses deckSource for road order across polling and resize", async () => {
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const listeners = new Map();
  const pane = { clientWidth: 900, clientHeight: 400 };
  let payload = {
    deckSource: "graph",
    buckets: ["verify", "build", "scout"],
    tasks: [
      makeNode("scout/01", "scout", "01"),
      makeNode("verify/01", "verify", "01"),
    ],
  };
  const replacements = {
    document: {
      hidden: true,
      querySelector: (selector) =>
        selector === ".c-dependency-graph" ? pane : null,
      addEventListener() {},
    },
    window: {
      addEventListener: (name, callback) => listeners.set(name, callback),
    },
    getComputedStyle: () => ({
      paddingBlockStart: "0",
      paddingBlockEnd: "0",
      paddingInlineStart: "0",
      paddingInlineEnd: "0",
    }),
    fetch: async () => ({ ok: true, json: async () => payload }),
    EventSource: class {
      addEventListener() {}
    },
  };

  try {
    for (const [key, value] of Object.entries(replacements)) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value,
      });
    }
    const { loadTree, store } = await import("../app.js");
    const roads = () =>
      [
        ...store.graphSvg.matchAll(/class="graph-road" data-road="([^"]+)"/g),
      ].map((match) => match[1]);

    await loadTree();
    expect(roads()).toEqual(["verify", "build", "scout"]);
    payload.buckets = ["scout", "verify", "build"];
    await loadTree();
    expect(roads()).toEqual(payload.buckets);
    pane.clientHeight = 600;
    listeners.get("resize")();
    expect(roads()).toEqual(payload.buckets);

    payload = { ...payload, deckSource: "tasks", source: "graph" };
    await loadTree();
    expect(roads()).toEqual(["scout", "verify"]);
    expect(store.graphSvg).toBe(
      renderGraph(
        payload.tasks,
        layoutGraph(payload.tasks, {
          availableWidth: 900,
          availableHeight: 600,
        }),
      ),
    );
    pane.clientHeight = 400;
    listeners.get("resize")();
    expect(roads()).toEqual(["scout", "verify"]);
  } finally {
    for (const key of Object.keys(replacements)) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  }
});

describe("relatedRefs", () => {
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

describe("route current", () => {
  test("lays a flow overlay inside a same-road link", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect(svg).toContain('class="graph-flow"');
    expect((svg.match(/class="graph-flow"/g) ?? []).length).toBe(
      (svg.match(/class="graph-link"/g) ?? []).length,
    );
    expect(svg).toMatch(
      /class="graph-flow"[^>]*data-from="api\/01" data-to="api\/02"/,
    );
  });

  test("lays one inside a crossover too, on the same path", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("ui/01", "ui", "01", ["api/01"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    const crossover = svg.match(
      /class="graph-crossover[^"]*"[^>]*d="([^"]+)"/,
    )[1];
    const flow = svg.match(/class="graph-flow"[^>]*d="([^"]+)"/)[1];

    expect(flow).toBe(crossover);
    expect(svg).toMatch(
      /class="graph-flow"[^>]*data-from="api\/01" data-to="ui\/01"/,
    );
  });

  test("draws the flow narrower than the rail, so it never erases the track it runs inside", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
    ];
    const svg = renderGraph(nodes, layoutGraph(nodes));

    const rail = Number(
      svg.match(/class="graph-link" stroke-width="([\d.]+)"/)[1],
    );
    const flow = Number(
      svg.match(/class="graph-flow" stroke-width="([\d.]+)"/)[1],
    );

    expect(flow).toBeLessThan(rail);
  });
});

describe("edge identity", () => {
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

  test("a berth packed right of its depth carries its dependents with it", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
      makeNode("api/03", "api", "03", ["api/01"]),
      makeNode("api/04", "api", "04", ["api/02", "api/03"]),
      makeNode("api/08", "api", "08", ["api/03", "api/02"]),
      makeNode("api/09", "api", "09", ["api/02"]),
      makeNode("studio/01", "studio", "01"),
      makeNode("studio/02", "studio", "02", ["studio/01", "api/08"]),
    ];
    const layout = layoutGraph(nodes);

    expect(layout.positions.get("studio/02").slot).toBeGreaterThan(
      layout.positions.get("api/08").slot,
    );
  });

  test("every drawn edge runs left to right", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
      makeNode("api/03", "api", "03", ["api/01"]),
      makeNode("api/04", "api", "04", ["api/02", "api/03"]),
      makeNode("ui/01", "ui", "01"),
      makeNode("ui/02", "ui", "02", ["ui/01", "api/04"]),
      makeNode("ops/01", "ops", "01", ["ui/02"]),
      makeNode("ops/02", "ops", "02", ["api/02"]),
    ];
    const layout = layoutGraph(nodes);

    for (const node of nodes) {
      for (const dependency of node.dependsOn) {
        expect(layout.positions.get(node.ref).slot).toBeGreaterThan(
          layout.positions.get(dependency).slot,
        );
      }
    }
  });

  test("a cycle still settles instead of chasing its own slots", () => {
    const nodes = [
      makeNode("api/01", "api", "01", ["api/02"]),
      makeNode("api/02", "api", "02", ["api/01"]),
      makeNode("ui/01", "ui", "01", ["api/01"]),
    ];
    const layout = layoutGraph(nodes);

    expect(layout.cyclic.sort()).toEqual(["api/01", "api/02", "ui/01"]);
    for (const ref of ["api/01", "api/02", "ui/01"]) {
      expect(Number.isFinite(layout.positions.get(ref).slot)).toBe(true);
    }
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
  const nodes = [
    makeNode("a/01", "a", "01"),
    makeNode("b/01", "b", "01"),
    makeNode("b/02", "b", "02", ["b/01"]),
    makeNode("b/03", "b", "03", ["a/01"]),
  ];

  const pathPoints = (svg, from, to) => {
    const d = svg.match(
      new RegExp(`data-from="${from}" data-to="${to}"[^>]*d="([^"]+)"`),
    )[1];
    return [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(([, x, y]) => [
      Number(x),
      Number(y),
    ]);
  };

  test("changes road inside a gap, never over another berth", () => {
    const layout = layoutGraph(nodes);
    const turnX = layout.turns.get("a/01->b/03");
    const { berthWidth } = layout.geometry;

    expect(turnX).toBeGreaterThan(0);
    for (const [ref, p] of layout.positions) {
      if (ref === "a/01" || ref === "b/03") continue;
      const covers = turnX > p.x && turnX < p.x + berthWidth;
      expect(covers).toBe(false);
    }
  });

  test("the change of road happens inside the reserved gap", () => {
    const layout = layoutGraph(nodes);
    const svg = renderGraph(nodes, layout);
    const pts = pathPoints(svg, "a\\/01", "b\\/03");
    const { slotGap } = layout.geometry;
    const turnX = layout.turns.get("a/01->b/03");

    for (const [x] of pts.slice(1, -1)) {
      expect(x).toBeGreaterThanOrEqual(turnX - slotGap / 2);
      expect(x).toBeLessThanOrEqual(turnX + slotGap / 2);
    }
    const railY = (ref) => layout.roads[layout.positions.get(ref).road].y;
    expect(pts[1][1]).toBeCloseTo(railY("a/01"), 1);
    expect(pts.at(-2)[1]).toBeCloseTo(railY("b/03"), 1);
  });

  test("both ends leave and meet their road horizontally", () => {
    const svg = renderGraph(nodes, layoutGraph(nodes));
    const [, [, turnInY], [, leadInY], [, leadOutY], [, turnOutY]] = pathPoints(
      svg,
      "a\\/01",
      "b\\/03",
    );

    expect(leadInY).toBe(turnInY);
    expect(leadOutY).toBe(turnOutY);
  });

  test("the curve stays inside its footprint at any ease, even once its control points cross", () => {
    const layout = layoutGraph(nodes);
    for (const crossoverEase of [0, 0.5, 1, 4]) {
      const pts = pathPoints(
        renderGraph(nodes, layout, { crossoverEase }),
        "a\\/01",
        "b\\/03",
      );
      const [, [left], , , [right]] = pts;

      for (const [x] of pts.slice(1, -1)) {
        expect(x).toBeGreaterThanOrEqual(left);
        expect(x).toBeLessThanOrEqual(right);
      }
    }
  });

  test("the ease bends the curve without moving its ends", () => {
    const layout = layoutGraph(nodes);
    const ends = (crossoverEase) => {
      const pts = pathPoints(
        renderGraph(nodes, layout, { crossoverEase }),
        "a\\/01",
        "b\\/03",
      );
      return [pts.at(0), pts.at(1), pts.at(-2), pts.at(-1)];
    };

    expect(ends(0.8)).toEqual(ends(0.2));
    const control = (crossoverEase) =>
      pathPoints(
        renderGraph(nodes, layout, { crossoverEase }),
        "a\\/01",
        "b\\/03",
      )[2][0];
    expect(control(0.8)).toBeGreaterThan(control(0.2));
  });

  test("a crossover with no room to curve falls back to a straight line", () => {
    const layout = layoutGraph(nodes);
    const cramped = { ...layout, geometry: { ...layout.geometry, slotGap: 0 } };
    const d = renderGraph(nodes, cramped).match(
      /data-from="a\/01" data-to="b\/03"[^>]*d="([^"]+)"/,
    )[1];

    expect(d).toMatch(/^M [\d.]+,[\d.]+ L [\d.]+,[\d.]+$/);
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

  test("the head stacks three lamps and stands taller than the plate it gates", () => {
    const nodes = [
      makeNode("api/01", "api", "01"),
      makeNode("api/02", "api", "02", ["api/01"]),
    ];
    const layout = layoutGraph(nodes);
    const svg = renderGraph(nodes, layout);

    for (const aspect of ["clear", "caution", "danger"]) {
      expect(svg).toContain(`class="lamp -${aspect}"`);
    }

    const housing = Number(
      svg.match(/class="housing"[^>]*height="([\d.]+)"/)[1],
    );
    const rail = Number(svg.match(/class="rail" stroke-width="([\d.]+)"/)[1]);
    expect(housing).toBeGreaterThan(rail * 2);
    const plate = Number(svg.match(/class="segment"[^>]*height="([\d.]+)"/)[1]);
    expect(housing).toBeGreaterThan(plate);

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
    expect(Number(link.match(/x1="([\d.]+)"/)[1])).toBe(
      layout.positions.get("api/01").x + layout.geometry.berthWidth,
    );
    expect(Number(link.match(/x2="([\d.]+)"/)[1])).toBe(
      layout.positions.get("api/02").x,
    );
  });

  test("breaks at a berth the dependency reaches past, so the lit route never runs through it", () => {
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
    expect(edges[0][1]).toBe(blocker.x);
    expect(edges[1][0]).toBe(blocker.x + layout.geometry.berthWidth);
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

describe("the berth plate", () => {
  const nodes = [
    makeNode("api/01", "api", "01"),
    makeNode("api/02", "api", "02", ["api/01"]),
  ];

  test("the plate is sized to the longest ref, and every plate shares it", () => {
    const short = layoutGraph([makeNode("a/01", "a", "01")]).geometry
      .berthWidth;
    const long = layoutGraph([
      makeNode("provisioning/01", "provisioning", "01"),
      makeNode("a/01", "a", "01"),
    ]).geometry.berthWidth;

    expect(long).toBeGreaterThan(short);
    expect(Number.isInteger(long)).toBe(true);
    const layout = layoutGraph(nodes);
    const [first, second] = [...layout.positions.values()];
    expect(second.x - first.x).toBe(
      layout.geometry.berthWidth + layout.geometry.slotGap,
    );
  });

  test("both figure columns are held open before a reading arrives, so the panel never reflows under a ticking clock", () => {
    const bare = layoutGraph(nodes);
    const reported = layoutGraph(nodes, {
      usage: { byTask: { "api/01": { cacheWrite: 145_000 } } },
    });

    expect(reported.geometry.berthWidth).toBe(bare.geometry.berthWidth);

    const svg = renderGraph(nodes, bare, {
      usage: { byTask: { "api/01": { cacheWrite: 145_000 } } },
      elapsed: { "api/01": { ms: 754_000, live: false } },
    });
    const tokenX = Number(
      svg.match(/class="graph-tokens"[^>]*x="([\d.]+)"/)[1],
    );
    const elapsedX = Number(
      svg.match(/class="graph-elapsed"[^>]*x="([\d.]+)"/)[1],
    );
    const plate = bare.positions.get("api/01");

    expect(svg).toContain(">145.0K</text>");
    expect(svg).toContain(">12m 34s</text>");
    expect(tokenX).toBeGreaterThan(plate.x);
    expect(elapsedX).toBeLessThanOrEqual(plate.x + bare.geometry.berthWidth);
    expect(elapsedX - tokenX).toBeGreaterThan(
      "145.0K".length * 14 * 0.75 * 0.6,
    );
  });

  test("the ref takes the first line and the two figures the second", () => {
    const layout = layoutGraph(nodes);
    const svg = renderGraph(nodes, layout, {
      usage: { byTask: { "api/01": { cacheWrite: 145_000 } } },
      elapsed: { "api/01": { ms: 5_400, live: false } },
    });
    const plate = layout.positions.get("api/01");
    const height = Number(
      svg.match(/class="segment"[^>]*height="([\d.]+)"/)[1],
    );
    const refY = Number(svg.match(/class="graph-ref"[^>]*y="([\d.]+)"/)[1]);
    const tokenY = Number(
      svg.match(/class="graph-tokens"[^>]*y="([\d.]+)"/)[1],
    );
    const elapsedY = Number(
      svg.match(/class="graph-elapsed"[^>]*y="([\d.]+)"/)[1],
    );

    for (const y of [refY, tokenY, elapsedY]) {
      expect(y).toBeGreaterThan(plate.y);
      expect(y).toBeLessThan(plate.y + height);
    }
    expect(refY).toBeLessThan(tokenY);
    expect(tokenY).toBe(elapsedY);
    const refHeight = 14 * 0.85;
    const figureHeight = 14 * 0.75;
    const blockTop = refY - refHeight * 0.35 - refHeight / 2;
    const blockBottom = elapsedY - figureHeight * 0.35 + figureHeight / 2;

    expect(blockTop - plate.y).toBeCloseTo(plate.y + height - blockBottom, 1);
  });

  test("a plate with no reading yet carries neither figure", () => {
    const svg = renderGraph(nodes, layoutGraph(nodes));

    expect(svg).toContain('class="graph-ref"');
    expect(svg).not.toContain('class="graph-tokens"');
    expect(svg).not.toContain('class="graph-elapsed"');
  });

  test("a running task stamps its start so the figure can tick in place", () => {
    const layout = layoutGraph(nodes);
    const running = renderGraph(nodes, layout, {
      elapsed: { "api/01": { ms: 30_000, live: true, startMs: 1_700_000_000 } },
    });
    const settled = renderGraph(nodes, layout, {
      elapsed: {
        "api/01": { ms: 30_000, live: false, startMs: 1_700_000_000 },
      },
    });

    expect(running).toContain('data-elapsed-since="1700000000"');
    expect(settled).not.toContain("data-elapsed-since");
    expect(settled).toContain(">30.0s</text>");
  });

  test("state lights the leading edge, and leaves the plate body readable", () => {
    const svg = renderGraph(nodes, layoutGraph(nodes));
    const body = Number(svg.match(/class="segment"[^>]*width="([\d.]+)"/)[1]);
    const edge = Number(svg.match(/class="status"[^>]*width="([\d.]+)"/)[1]);

    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(body / 10);
  });

  test("the rail keeps its own weight now the plate stands on it", () => {
    const svg = renderGraph(nodes, layoutGraph(nodes));
    const rail = Number(svg.match(/class="rail" stroke-width="([\d.]+)"/)[1]);
    const plate = Number(svg.match(/class="segment"[^>]*height="([\d.]+)"/)[1]);

    expect(rail).toBeLessThan(plate);
    const link = Number(
      svg.match(/class="graph-link" stroke-width="([\d.]+)"/)[1],
    );
    expect(link).toBe(rail);
  });
});

describe("panel tokens", () => {
  const nodes = [
    makeNode("api/01", "api", "01"),
    makeNode("api/02", "api", "02"),
  ];

  test("draws the count under the berth, untiered, since a task total would trip every per-agent tier", () => {
    const svg = renderGraph(nodes, layoutGraph(nodes), {
      usage: {
        byTask: { "api/01": { cacheWrite: 92_400, cacheRead: 900_000 } },
        codexByTask: {},
      },
    });

    expect(svg).toContain('class="graph-tokens"');
    expect(svg).toContain(">92.4K</text>");
    expect(svg).not.toContain("-warn");
    expect(svg).not.toContain("-danger");
  });

  test("sums the Claude and codex figures into the one plate figure", () => {
    const svg = renderGraph(nodes, layoutGraph(nodes), {
      usage: {
        byTask: { "api/01": { cacheWrite: 92_400 } },
        codexByTask: { "api/01": { cacheWrite: 7_600 } },
      },
    });

    expect(svg).toContain(">100.0K</text>");
  });

  test("prints the Claude figure alone for a task no external engine touched", () => {
    const svg = renderGraph(nodes, layoutGraph(nodes), {
      usage: {
        byTask: { "api/01": { cacheWrite: 92_400 } },
        codexByTask: {},
      },
    });

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

  test("height grows exactly one pitch per road, carrying no float error from a fractional plate", () => {
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
    const oneRoad = [
      makeNode("contract/01", "contract", "01"),
      makeNode("contract/02", "contract", "02", ["contract/01"]),
      makeNode("contract/03", "contract", "03", ["contract/02"]),
      makeNode("contract/04", "contract", "04", ["contract/03"]),
      makeNode("contract/05", "contract", "05", ["contract/04"]),
      makeNode("contract/06", "contract", "06", ["contract/05"]),
    ];

    test("the gutter is the road name's own width in whole pixels, not a flat allowance", () => {
      const long = layoutGraph(oneRoad).geometry.gutter;
      const short = layoutGraph([makeNode("ui/01", "ui", "01")]).geometry
        .gutter;

      expect(long).toBeLessThan(14 * 9);
      expect(short).toBeLessThan(long);
      expect(Number.isInteger(long)).toBe(true);
    });

    test("gaps compress so the panel fits the pane, never a pixel over", () => {
      const natural = layoutGraph(oneRoad);
      const fitted = layoutGraph(oneRoad, { availableWidth: 1_300 });

      expect(natural.extent.width).toBeGreaterThan(1_300);
      expect(fitted.extent.width).toBeLessThanOrEqual(1_300);
      expect(fitted.geometry.slotGap).toBeLessThan(natural.geometry.slotGap);
      const [first, second] = [...fitted.positions.values()];
      expect(fitted.geometry.berthWidth).toBe(natural.geometry.berthWidth);
      expect(second.x - first.x - fitted.geometry.berthWidth).toBe(
        fitted.geometry.slotGap,
      );
    });

    test("compression stops at the floor rather than crushing the gap", () => {
      const crushed = layoutGraph(oneRoad, { availableWidth: 120 });

      expect(crushed.geometry.slotGap).toBe(14 * 4);
      expect(crushed.extent.width).toBeGreaterThan(120);
    });

    test("a pane wider than the panel never stretches it", () => {
      const roomy = layoutGraph(oneRoad, { availableWidth: 5_000 });

      expect(roomy.geometry.slotGap).toBe(14 * 6);
      expect(roomy.extent.width).toBe(layoutGraph(oneRoad).extent.width);
    });

    test("the render lands on the geometry the layout fitted", () => {
      const layout = layoutGraph(oneRoad, { availableWidth: 1_300 });
      const svg = renderGraph(oneRoad, layout);
      const railStart = Number(svg.match(/class="rail"[^>]*x1="([\d.]+)"/)[1]);
      const housing = Number(svg.match(/class="housing" x="([\d.]+)"/)[1]);
      const gated = [...layout.positions.values()][1];

      expect(railStart).toBe(14 + layout.geometry.gutter);
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
