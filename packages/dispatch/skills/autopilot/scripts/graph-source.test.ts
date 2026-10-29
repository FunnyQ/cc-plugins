import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type FlightlogEntry,
  type StateEntry,
  type StateFields,
  parseLog,
} from "../../flightplan/scripts/lib/flightlog";
import { aggregateFleet, deriveTaskViews } from "./fleet";
import { buildTreePayload } from "./tree-api";
import {
  type GraphNode,
  unmetNodeDependencies,
} from "../../flightplan/scripts/lib/graph-node";
import { applyStateEntries, loadGraph, parseGraph } from "./graph-source";

function node(overrides: Record<string, unknown> = {}) {
  return { ref: "build/01", lane: "build", title: "Build", ...overrides };
}

function fixture(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    title: "Run",
    repoRoot: "/repo",
    lanes: ["build", "empty"],
    nodes: [node()],
    ...overrides,
  });
}

const expectedNode: GraphNode = {
  ref: "build/01",
  bucket: "build",
  nn: "01",
  title: "Build",
  status: null,
  validity: { kind: "unfinished", status: null },
  dependsOn: [],
  blocks: [],
  finalReview: false,
};

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "graph-source-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("parseGraph", () => {
  test("maps every node and preserves lane order, including empty lanes", () => {
    expect(
      parseGraph(
        fixture({
          lanes: ["empty", "build"],
          nodes: [
            node({ nn: "99", status: "done" }),
            node({
              ref: "review/02",
              dependsOn: ["build/01"],
              blocks: ["absent/99"],
              finalReview: true,
            }),
          ],
        }),
        "label",
        "fallback",
      ),
    ).toEqual({
      title: "Run",
      repoRoot: "/repo",
      lanes: ["empty", "build"],
      errors: [],
      nodes: {
        "build/01": expectedNode,
        "review/02": {
          ...expectedNode,
          ref: "review/02",
          nn: "02",
          dependsOn: ["build/01"],
          blocks: ["absent/99"],
          finalReview: true,
        },
      },
    });
  });

  test("uses the explicit fallback independently of the error label", () => {
    expect(
      parseGraph(
        fixture({ title: undefined }),
        "/unrelated/graph.json",
        "chosen",
      ),
    ).toEqual({
      title: "chosen",
      repoRoot: "/repo",
      lanes: ["build", "empty"],
      nodes: { "build/01": expectedNode },
      errors: [],
    });
  });

  test("accepts unspecified shapes without inventing validation rules", () => {
    const result = parseGraph(
      fixture({
        title: "",
        lanes: ["", "unused"],
        extra: true,
        nodes: [
          node({
            ref: "a0-/00",
            lane: "",
            title: "\n",
            dependsOn: ["a0-/00", "a0-/00"],
            blocks: ["anything"],
          }),
        ],
      }),
      "label",
      "fallback",
    );
    expect(result).toEqual({
      title: "",
      repoRoot: "/repo",
      lanes: ["", "unused"],
      errors: [],
      nodes: {
        "a0-/00": {
          ...expectedNode,
          ref: "a0-/00",
          bucket: "",
          nn: "00",
          title: "\n",
          dependsOn: ["a0-/00", "a0-/00"],
          blocks: ["anything"],
        },
      },
    });
  });

  for (const value of [null, [], 1, true, "root"]) {
    test(`rejects non-object root ${JSON.stringify(value)}`, () => {
      const result = parseGraph(JSON.stringify(value), "label", "fallback");
      expect(result).toEqual({
        title: "fallback",
        repoRoot: "",
        lanes: [],
        nodes: {},
        errors: [
          {
            file: "label",
            bucket: "",
            reason: `root must be an object; received ${JSON.stringify(value)}`,
          },
        ],
      });
    });
  }

  test("reports malformed JSON with the offending text", () => {
    const result = parseGraph("{broken", "label", "fallback");
    expect(result.nodes).toEqual({});
    expect(result.errors).toEqual([
      { file: "label", bucket: "", reason: expect.stringContaining("{broken") },
    ]);
  });

  const topCases: [string, unknown[]][] = [
    ["version", [undefined, null, "1", 0, 2, true]],
    ["title", [null, 7, false, [], {}]],
    ["repoRoot", [undefined, null, 1, "", "relative/path"]],
    ["lanes", [undefined, null, "build", [], ["build", 4], ["build", "build"]]],
    ["nodes", [undefined, null, {}, []]],
  ];
  for (const [field, values] of topCases) {
    for (const value of values) {
      test(`rejects ${field}=${JSON.stringify(value)}`, () => {
        const result = parseGraph(
          fixture({ [field]: value }),
          "label",
          "fallback",
        );
        expect(result.nodes).toEqual({});
        expect(result.errors).toContainEqual({
          file: "label",
          bucket: "",
          reason: expect.stringContaining(`${field}`),
        });
        expect(
          result.errors.some((error) =>
            error.reason.includes(
              value === undefined ? "missing" : JSON.stringify(value),
            ),
          ),
        ).toBe(true);
      });
    }
  }

  const nodeCases: [string, unknown[]][] = [
    [
      "ref",
      [
        undefined,
        null,
        12,
        "Build/01",
        "build/1",
        "build/001",
        "1build/01",
        "build_/01",
        "build/01\n",
      ],
    ],
    ["lane", [undefined, null, 12, "other"]],
    ["title", [undefined, null, 12]],
    ["dependsOn", [null, "build/01", [1], ["build/01", false]]],
    ["blocks", [null, "build/01", [1], ["build/01", false]]],
    ["finalReview", [null, "true", 1, [], {}]],
  ];
  for (const [field, values] of nodeCases) {
    for (const value of values) {
      test(`rejects node ${field}=${JSON.stringify(value)} without partial loading`, () => {
        const result = parseGraph(
          fixture({
            nodes: [node({ ref: "build/02" }), node({ [field]: value })],
          }),
          "label",
          "fallback",
        );
        expect(result.nodes).toEqual({});
        expect(result.errors).toContainEqual({
          file: "label",
          bucket:
            field === "lane"
              ? typeof value === "string"
                ? value
                : ""
              : "build",
          reason: expect.stringContaining(field),
        });
        expect(
          result.errors.some((error) =>
            error.reason.includes(
              value === undefined ? "missing" : JSON.stringify(value),
            ),
          ),
        ).toBe(true);
      });
    }
  }

  for (const value of [null, [], "node", 1, true]) {
    test(`rejects non-object node ${JSON.stringify(value)}`, () => {
      const result = parseGraph(
        fixture({ nodes: [node(), value] }),
        "label",
        "fallback",
      );
      expect(result.nodes).toEqual({});
      expect(result.errors).toEqual([
        {
          file: "label",
          bucket: "",
          reason: `nodes[1] must be an object; received ${JSON.stringify(value)}`,
        },
      ]);
    });
  }

  test("reports duplicate refs and competing final reviews", () => {
    const result = parseGraph(
      fixture({
        nodes: [node({ finalReview: true }), node({ finalReview: true })],
      }),
      "label",
      "fallback",
    );
    expect(result.nodes).toEqual({});
    expect(result.errors).toEqual([
      {
        file: "label",
        bucket: "build",
        reason: expect.stringMatching(/ref.*duplicate.*"build\/01"/),
      },
      {
        file: "label",
        bucket: "build",
        reason: expect.stringMatching(/finalReview.*"build\/01"/),
      },
    ]);
  });

  test("removes dangling dependencies, retains valid edges and advisory blocks", () => {
    const result = parseGraph(
      fixture({
        nodes: [
          node({
            dependsOn: ["absent/01", "__proto__"],
            blocks: ["absent/01"],
          }),
          node({ ref: "build/02", dependsOn: ["build/01", "absent/02"] }),
        ],
      }),
      "label",
      "fallback",
    );
    expect(result.nodes).toEqual({
      "build/01": { ...expectedNode, blocks: ["absent/01"] },
      "build/02": {
        ...expectedNode,
        ref: "build/02",
        nn: "02",
        dependsOn: ["build/01"],
      },
    });
    expect(result.errors).toEqual(
      ["absent/01", "__proto__", "absent/02"].map((ref) => ({
        file: "label",
        bucket: "build",
        reason: expect.stringContaining(JSON.stringify(ref)),
      })),
    );
    expect(
      unmetNodeDependencies(result.nodes["build/01"], result.nodes),
    ).toEqual([]);
    expect(
      unmetNodeDependencies(result.nodes["build/02"], result.nodes),
    ).toEqual(["build/01"]);
  });
});

describe("loadGraph", () => {
  test("reads graph.json and supplies the directory basename", () =>
    withDir(async (dir) => {
      const text = fixture({ title: undefined });
      await writeFile(join(dir, "graph.json"), text);
      expect(await loadGraph(dir)).toEqual(
        parseGraph(text, join(dir, "graph.json"), basename(dir)),
      );
    }));

  test("returns parser errors with the file path", () =>
    withDir(async (dir) => {
      await writeFile(join(dir, "graph.json"), "{broken");
      expect(await loadGraph(dir)).toEqual(
        parseGraph("{broken", join(dir, "graph.json"), basename(dir)),
      );
    }));

  for (const unreadable of [false, true]) {
    test(`returns an error for ${unreadable ? "unreadable" : "missing"} graph.json`, () =>
      withDir(async (dir) => {
        // A directory at graph.json produces a real read failure even when tests run as root.
        if (unreadable) await mkdir(join(dir, "graph.json"));
        expect(await loadGraph(dir)).toEqual({
          title: basename(dir),
          repoRoot: "",
          lanes: [],
          nodes: {},
          errors: [
            {
              file: join(dir, "graph.json"),
              bucket: "",
              reason: expect.stringContaining("read"),
            },
          ],
        });
      }));
  }
});

function loadedNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    ...expectedNode,
    ref: "build-step/01",
    bucket: "build-step",
    ...overrides,
  };
}

function declaration(
  state: StateEntry["state"],
  overrides: Partial<StateFields> = {},
): StateEntry {
  return {
    kind: "state",
    task: "build-step/01",
    ts: "2026-01-01T00:00:00Z",
    state,
    ...overrides,
  } as StateEntry;
}

describe("applyStateEntries", () => {
  for (const [state, status, validity] of [
    ["done", "done", { kind: "complete" }],
    ["blocked", "blocked", { kind: "unfinished", status: "blocked" }],
    [
      "failed",
      "in-progress",
      { kind: "invalid", rule: "failed", reason: "agent failed" },
    ],
  ] as const) {
    test(`maps ${state} without mutating either input`, () => {
      const original = loadedNode({ status: "in-progress" });
      const nodes = { [original.ref]: original };
      const entries = [declaration(state, { message: "agent failed" })];
      const before = structuredClone({ nodes, entries });
      const result = applyStateEntries(nodes, entries);
      expect(result).toEqual({
        nodes: { [original.ref]: { ...original, status, validity } },
        errors: [],
      });
      expect({ nodes, entries }).toEqual(before);
      expect(result.nodes).not.toBe(nodes);
    });
  }

  test("uses a useful failure reason when the message is absent", () => {
    const original = loadedNode();
    expect(
      applyStateEntries({ [original.ref]: original }, [declaration("failed")]),
    ).toEqual({
      nodes: {
        [original.ref]: {
          ...original,
          status: "todo",
          validity: {
            kind: "invalid",
            rule: "failed",
            reason: "agent reported failure with no message",
          },
        },
      },
      errors: [],
    });
  });

  test("last trail position wins for equal and backwards timestamps", () => {
    const original = loadedNode();
    for (const ts of ["2026-01-01T00:00:00Z", "2025-01-01T00:00:00Z"]) {
      expect(
        applyStateEntries({ [original.ref]: original }, [
          declaration("done"),
          declaration("failed"),
          declaration("blocked", { ts }),
        ]),
      ).toEqual({
        nodes: {
          [original.ref]: {
            ...original,
            status: "blocked",
            validity: { kind: "unfinished", status: "blocked" },
          },
        },
        errors: [],
      });
    }
  });

  test("unknown latest state invalidates the node and reports an error", () => {
    const original = loadedNode();
    const entries = parseLog(
      JSON.stringify({ ...declaration("done"), state: "paused" }),
    );
    const reason = 'Node "build-step/01" declares unknown state "paused"';
    expect(applyStateEntries({ [original.ref]: original }, entries)).toEqual({
      nodes: {
        [original.ref]: {
          ...original,
          status: "todo",
          validity: { kind: "invalid", rule: "unknown-state", reason },
        },
      },
      errors: [
        { file: join(".flightlog", "run.jsonl"), bucket: "build-step", reason },
      ],
    });
    expect(
      applyStateEntries({ [original.ref]: original }, [
        ...entries,
        declaration("done"),
      ]),
    ).toEqual({
      nodes: {
        [original.ref]: {
          ...original,
          status: "done",
          validity: { kind: "complete" },
        },
      },
      errors: [],
    });
  });

  test("checks all entry kinds and reports each unknown ref once", () => {
    const original = loadedNode({ status: "todo" });
    const entries: FlightlogEntry[] = [
      declaration("done", { task: "missing-state/01" }),
      {
        kind: "note",
        task: "missing-note/01",
        ts: "same",
        role: "dev",
        message: "hi",
      },
      {
        kind: "score",
        task: "missing-score/01",
        ts: "same",
        attempt: 1,
        weighted: 5,
        passed: true,
        hardFailed: false,
        missing: [],
        threshold: 4,
        passOp: ">=",
        breakdown: [],
      },
      declaration("failed", { task: "missing-note/01" }),
      declaration("done", { task: "__proto__" }),
    ];
    expect(
      applyStateEntries({ [original.ref]: original }, [...entries, ...entries]),
    ).toEqual({
      nodes: { [original.ref]: original },
      errors: [
        "missing-state/01",
        "missing-note/01",
        "missing-score/01",
        "__proto__",
      ].map((ref) => ({
        file: join(".flightlog", "run.jsonl"),
        bucket: "",
        reason: `Entry task ${JSON.stringify(ref)} references an undeclared node`,
      })),
    });
  });

  test("preserves untouched fields and normalizes only null status", () => {
    const original = loadedNode();
    const done = loadedNode({
      ref: "build-step/02",
      status: "done",
      validity: { kind: "complete" },
    });
    expect(
      applyStateEntries({ [original.ref]: original, [done.ref]: done }, []),
    ).toEqual({
      nodes: {
        [original.ref]: { ...original, status: "todo" },
        [done.ref]: done,
      },
      errors: [],
    });
    expect(
      deriveTaskViews(
        applyStateEntries({ [original.ref]: original }, []).nodes,
        [],
      )[0],
    ).toEqual({
      ref: original.ref,
      bucket: original.bucket,
      nn: original.nn,
      title: original.title,
      status: "todo",
      state: "ready",
      invalidReason: null,
      blockedBy: [],
      dependsOn: [],
      blocks: [],
      finalReview: false,
      attempts: 0,
      latestScore: null,
    });
  });

  test("derives all five states and forwards mapping errors into the payload", () => {
    const nodes = Object.fromEntries(
      ["01", "02", "03", "04", "05"].map((nn) => {
        const value = loadedNode({
          ref: `build-step/${nn}`,
          nn,
          dependsOn:
            nn === "03"
              ? ["build-step/01"]
              : nn === "04"
                ? ["build-step/02"]
                : [],
        });
        return [value.ref, value];
      }),
    );
    const entries: FlightlogEntry[] = [
      declaration("done"),
      {
        kind: "note",
        task: "build-step/02",
        ts: "same",
        role: "dev",
        phase: "start",
        message: "working",
      },
      declaration("failed", { task: "build-step/05", message: "broken" }),
      declaration("done", { task: "missing-step/01" }),
    ];
    const mapped = applyStateEntries(nodes, entries);
    const payload = buildTreePayload({
      slug: "run",
      planTitle: "Run",
      repo: "repo",
      bucketDirs: ["build-step"],
      loaded: { byRef: mapped.nodes, errors: mapped.errors },
      entries,
    });
    expect(payload.tasks.map(({ state }) => state)).toEqual([
      "done",
      "in-progress",
      "ready",
      "blocked",
      "invalid",
    ]);
    expect(payload.counts).toEqual({
      total: 5,
      done: 1,
      inProgress: 1,
      ready: 1,
      blocked: 1,
      invalid: 1,
    });
    expect(payload.errors).toEqual(mapped.errors);
  });

  test("state declarations cannot close an open start even with a matching runtime identity", () => {
    const original = loadedNode({ status: "todo" });
    const entries = parseLog(
      [
        {
          kind: "note",
          task: original.ref,
          ts: "same",
          phase: "start",
          message: "working",
        },
        declaration("done"),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    expect(deriveTaskViews({ [original.ref]: original }, entries)).toEqual(
      deriveTaskViews({ [original.ref]: original }, entries.slice(0, 1)),
    );
    expect(
      deriveTaskViews({ [original.ref]: original }, entries)[0].state,
    ).toBe("in-progress");
  });
});

describe("committed deckplan example", () => {
  const exampleDir = join(import.meta.dir, "../../deckplan/references/example");

  test("loads the template directly and renders every node, counter, retry and score", async () => {
    const graph = await loadGraph(exampleDir);
    const trail = await readFile(join(exampleDir, "run.jsonl"), "utf-8");
    const entries = parseLog(trail);
    expect(entries).toHaveLength(trail.trim().split("\n").length);
    expect(graph.errors).toEqual([]);
    expect(Object.keys(graph.nodes)).toHaveLength(5);
    expect(graph.lanes).toEqual(["scout", "build", "audit"]);
    const mapped = applyStateEntries(graph.nodes, entries);
    expect(mapped.errors).toEqual([]);
    const views = deriveTaskViews(mapped.nodes, entries);
    expect(
      Object.fromEntries(
        views.map(({ ref, title, state }) => [ref, { title, state }]),
      ),
    ).toEqual({
      "scout/01": { title: "Inventory repository", state: "done" },
      "scout/02": { title: "Survey documentation", state: "ready" },
      "build/01": { title: "Draft repository guide", state: "in-progress" },
      "build/02": { title: "Review repository guide", state: "blocked" },
      "audit/01": { title: "Check license evidence", state: "invalid" },
    });
    expect(views.find(({ ref }) => ref === "build/01")?.dependsOn).toEqual([
      "scout/01",
    ]);
    expect(views.find(({ ref }) => ref === "build/02")?.blockedBy).toEqual([
      "build/01",
    ]);
    expect(views.find(({ ref }) => ref === "scout/01")?.attempts).toBe(2);
    expect(entries.filter(({ task }) => task === "scout/02")).toEqual([]);
    expect(
      entries.filter(
        (entry) => entry.kind === "state" && entry.state === "blocked",
      ),
    ).toEqual([]);
    const payload = buildTreePayload({
      deckSource: "graph",
      slug: "repository-tour",
      planTitle: graph.title,
      repo: graph.repoRoot,
      bucketDirs: graph.lanes,
      loaded: { byRef: mapped.nodes, errors: mapped.errors },
      entries,
    });
    expect(payload.buckets).toEqual(graph.lanes);
    expect(payload.counts).toEqual({
      total: 5,
      done: 1,
      inProgress: 1,
      ready: 1,
      blocked: 1,
      invalid: 1,
    });
    const fleet = aggregateFleet(entries);
    expect(fleet).toHaveLength(5);
    expect(
      fleet
        .filter(({ role, ref }) => role === "dev" && ref === "scout/01")
        .map(({ attempt, status }) => ({ attempt, status }))
        .sort((a, b) => a.attempt! - b.attempt!),
    ).toEqual([
      { attempt: 1, status: "finished" },
      { attempt: 2, status: "finished" },
    ]);
    const score = {
      weighted: 4.5,
      threshold: 4,
      passOp: ">=" as const,
      passed: true,
      hardFailed: false,
      breakdown: [
        { name: "accuracy", weight: 1, score: 5 },
        { name: "coverage", weight: 1, score: 4 },
      ],
    };
    expect(views.find(({ ref }) => ref === "scout/01")?.latestScore).toEqual(
      score,
    );
    expect(fleet.find(({ role }) => role === "judge")).toMatchObject({
      ref: "scout/01",
      attempt: 2,
      status: "finished",
      outcome: "passed",
      score,
    });
    expect(fleet.find(({ ref }) => ref === "build/01")?.status).toBe(
      "in-flight",
    );
    expect(entries.map(({ ts }) => ts)).toEqual(
      entries.map(({ ts }) => ts).sort(),
    );
  });

  test("every initial prompt embeds the shipped identity and absolute lifecycle paths", async () => {
    const runId = (await readFile(join(exampleDir, "run.id"), "utf-8")).trim();
    const script = await readFile(join(exampleDir, "workflow.js"), "utf-8");
    const graph = await loadGraph(exampleDir);
    const literals = Object.fromEntries(
      [...script.matchAll(/^  (\w+): "([^"\n]+)",$/gm)].map(
        ([, key, value]) => [key, value],
      ),
    );
    expect(literals.runId).toBe(runId);
    expect(literals.repoRoot).toBe(graph.repoRoot);
    for (const key of ["runDir", "flightlog", "repoRoot"])
      expect(literals[key]).toMatch(/^\//);
    const calls: { prompt: string; label: string }[] = [];
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.agent = async (prompt: string, options: { label: string }) => {
      calls.push({ prompt, label: options.label });
      return { ok: true };
    };
    globals.phase = () => {};
    globals.parallel = async (thunks: (() => Promise<unknown>)[]) =>
      Promise.all(thunks.map((thunk) => thunk()));
    await import(join(exampleDir, "workflow.js"));
    expect(calls).toHaveLength(5);
    const refs = [];
    for (const { prompt, label } of calls) {
      expect(prompt).toContain(runId);
      expect(prompt).toContain(literals.runDir!);
      expect(prompt).toContain(literals.repoRoot!);
      expect(prompt).not.toMatch(/\$|~\//);
      const lines = prompt.trim().split("\n");
      const start = lines[0]!;
      const end = lines.at(-1)!;
      const identity =
        /--task ([a-z][a-z0-9-]*\/\d{2}) --role (\w+) --attempt (\d+) --agent "([^"]+)"/;
      expect(start).toContain(
        `bun "${literals.flightlog}" log "${literals.runDir}/.flightlog/run.jsonl"`,
      );
      expect(start).toContain("--phase start");
      expect(end).toContain("--phase end --message");
      expect(start.match(identity)?.slice(1)).toEqual(
        end.match(identity)?.slice(1),
      );
      const ref = start.match(identity)![1]!;
      refs.push(ref);
      expect(prompt).toContain(
        `state "${literals.runDir}/.flightlog/run.jsonl" --task ${ref} --state done`,
      );
      expect(label).toBe(`dev:${ref}#1`);
      expect(start.match(identity)![4]).toBe(label);
    }
    expect(refs.sort()).toEqual(Object.keys(graph.nodes).sort());
    expect(script).not.toMatch(
      /\bimport\b|\brequire\s*\(|\b(?:Bun|process|Deno)\./,
    );
  });
});
