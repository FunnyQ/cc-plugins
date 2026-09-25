import { describe, expect, test } from "bun:test";
import { type ParsedTask, taskValidity } from "./parse-task";
import { findReady } from "../next-ready";
import {
  type GraphNode,
  type NodeValidity,
  nodesFromParsedTasks,
  unmetNodeDependencies,
} from "./graph-node";

function parsed(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    bucket: "api",
    nn: "01",
    title: "Build API",
    status: "todo",
    dependsOn: [{ bucket: "core", nn: "02" }],
    blocks: [{ bucket: "ui", nn: "03" }],
    finalReview: true,
    models: {},
    modelsRaw: null,
    modelErrors: [],
    h1: "# API-01: Build API",
    requiredReading: ["context.md"],
    sections: ["Verification"],
    body: "## Verification\n\n- [x] Run the suite\n",
    rubric: null,
    ...overrides,
  };
}

function node(validity: NodeValidity, dependsOn: string[] = []): GraphNode {
  return {
    ref: "api/01",
    bucket: "api",
    nn: "01",
    title: "API",
    status: "todo",
    dependsOn,
    blocks: [],
    finalReview: false,
    validity,
  };
}

describe("nodesFromParsedTasks", () => {
  test("maps exactly the narrow fields and preserves input keys without mutation", () => {
    const task = parsed();
    const before = structuredClone(task);
    expect(nodesFromParsedTasks({ "input/09": task })).toEqual({
      "input/09": {
        ref: "input/09",
        bucket: "api",
        nn: "01",
        title: "Build API",
        status: "todo",
        dependsOn: ["core/02"],
        blocks: ["ui/03"],
        finalReview: true,
        validity: { kind: "unfinished", status: "todo" },
      },
    });
    expect(task).toEqual(before);
  });

  test("accepts an empty tree", () => {
    expect(nodesFromParsedTasks({})).toEqual({});
  });

  test("passes through complete, unfinished, and invalid validity results", () => {
    const byRef = {
      "api/01": parsed({ status: "done" }),
      "api/02": parsed({ status: "in-progress" }),
      "api/03": parsed({ status: null }),
      "api/04": parsed({
        status: "done",
        body: "## Verification\n\n- [ ] Run the suite\n",
      }),
    };
    const nodes = nodesFromParsedTasks(byRef);
    for (const [ref, task] of Object.entries(byRef)) {
      expect(nodes[ref].validity).toEqual(taskValidity(task));
      expect(nodes[ref].status).toBe(task.status);
    }
    expect(nodes["api/01"].validity.kind).toBe("complete");
    expect(nodes["api/03"].validity.kind).toBe("invalid");
    expect(nodes["api/04"].validity.kind).toBe("invalid");
  });
});

describe("unmetNodeDependencies", () => {
  test("returns missing, unfinished, and invalid refs in dependency order", () => {
    const task = node({ kind: "unfinished", status: "queued" }, [
      "missing/01",
      "pending/01",
      "bad/01",
      "done/01",
    ]);
    expect(
      unmetNodeDependencies(task, {
        "pending/01": node({ kind: "unfinished", status: null }),
        "bad/01": node({
          kind: "invalid",
          rule: "external-source",
          reason: "Rejected",
        }),
        "done/01": node({ kind: "complete" }),
      }),
    ).toEqual(["missing/01", "pending/01", "bad/01"]);
  });

  test("returns no refs when every dependency is complete", () => {
    expect(
      unmetNodeDependencies(
        node({ kind: "unfinished", status: "todo" }, ["done/01", "done/02"]),
        {
          "done/01": node({ kind: "complete" }),
          "done/02": node({ kind: "complete" }),
        },
      ),
    ).toEqual([]);
  });

  test("an invalid node with no dependencies has no unmet refs", () => {
    expect(
      unmetNodeDependencies(
        node({ kind: "invalid", rule: "source", reason: "Bad node" }),
        {},
      ),
    ).toEqual([]);
  });

  test("is the one rule the scout CLI applies to a parsed tree", () => {
    const byRef = {
      "api/01": parsed({
        dependsOn: ["missing", "unfinished", "invalid", "complete"].map(
          (bucket) => ({ bucket, nn: "01" }),
        ),
      }),
      "unfinished/01": parsed({ bucket: "unfinished", dependsOn: [] }),
      "invalid/01": parsed({ status: null }),
      "complete/01": parsed({ status: "done" }),
    };
    const nodes = nodesFromParsedTasks(byRef);
    expect(unmetNodeDependencies(nodes["api/01"], nodes)).toEqual([
      "missing/01",
      "unfinished/01",
      "invalid/01",
    ]);
    // findReady reads this same function, so the scout parks api/01 on the same refs.
    expect(findReady(byRef)).toEqual([{ bucket: "unfinished", nn: "01" }]);
  });
});
