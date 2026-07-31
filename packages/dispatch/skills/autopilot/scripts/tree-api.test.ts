import { describe, expect, test } from "bun:test";
import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import type { ParsedTask } from "../../flightplan/scripts/lib/parse-task";
import { buildTreePayload, type Loaded } from "./tree-api";

function task(
  ref: string,
  status: ParsedTask["status"] = "todo",
  dependsOn: string[] = [],
): ParsedTask {
  const [bucket, nn] = ref.split("/");
  return {
    bucket,
    nn,
    title: `Task ${ref}`,
    h1: `# ${bucket.toUpperCase()}-${nn}: Task ${ref}`,
    requiredReading: [],
    dependsOn: dependsOn.map((dependency) => {
      const [dependencyBucket, dependencyNn] = dependency.split("/");
      return { bucket: dependencyBucket, nn: dependencyNn };
    }),
    blocks: [],
    status,
    finalReview: false,
    sections: [],
    body: "",
    rubric: null,
  };
}

function input(
  byRef: Record<string, ParsedTask> = {},
  bucketDirs: string[] = [],
  entries: FlightlogEntry[] = [],
  errors: Loaded["errors"] = [],
) {
  return {
    slug: "sample-plan",
    planTitle: "Sample Plan",
    bucketDirs,
    loaded: { byRef, errors },
    entries,
  };
}

describe("buildTreePayload", () => {
  test("renders the full tree", () => {
    const payload = buildTreePayload(
      input(
        {
          "server/01": task("server/01", "done"),
          "ui/01": task("ui/01", "todo", ["server/01"]),
        },
        ["ui", "server"],
        [
          {
            kind: "score",
            ts: "2026-08-01T00:00:00Z",
            task: "server/01",
            attempt: 2,
            weighted: 5,
            passed: true,
            hardFailed: false,
            missing: [],
            threshold: 4,
            passOp: ">=",
            breakdown: [],
          },
        ],
      ),
    );

    expect(payload.buckets).toEqual(["server", "ui"]);
    expect(payload.tasks).toHaveLength(2);
    expect(payload.tasks[0].attempts).toBe(2);
    expect(payload.tasks[1].state).toBe("ready");
  });

  test("accepts an empty entry list for a missing flightlog", () => {
    const payload = buildTreePayload(
      input({ "ui/01": task("ui/01") }, ["ui"], []),
    );

    expect(payload.tasks[0].attempts).toBe(0);
    expect(payload.tasks[0].latestScore).toBeNull();
  });

  test("includes a parse error while rendering other tasks", () => {
    const error = {
      file: "/plan/tasks/ui/02.md",
      bucket: "ui",
      reason: "missing H1",
    };
    const payload = buildTreePayload(
      input({ "ui/01": task("ui/01") }, ["ui"], [], [error]),
    );

    expect(payload.errors).toEqual([error]);
    expect(payload.tasks.map((view) => view.ref)).toEqual(["ui/01"]);
  });

  test("keeps a bucket when all of its files fail to parse", () => {
    const errors = ["01", "02"].map((nn) => ({
      file: `/plan/tasks/broken/${nn}.md`,
      bucket: "broken",
      reason: "missing H1",
    }));
    const payload = buildTreePayload(input({}, ["broken"], [], errors));

    expect(payload.buckets).toEqual(["broken"]);
    expect(payload.tasks).toEqual([]);
    expect(payload.errors).toEqual(errors);
  });

  test("keeps an empty bucket", () => {
    const payload = buildTreePayload(input({}, ["empty"]));

    expect(payload.buckets).toEqual(["empty"]);
    expect(payload.tasks).toEqual([]);
  });

  test("renders an empty tree", () => {
    const payload = buildTreePayload(input());

    expect(payload.buckets).toEqual([]);
    expect(payload.tasks).toEqual([]);
    expect(payload.counts).toEqual({
      total: 0,
      done: 0,
      inProgress: 0,
      ready: 0,
      blocked: 0,
    });
  });

  test("preserves a slug title fallback", () => {
    const fallback = input();
    fallback.planTitle = fallback.slug;

    expect(buildTreePayload(fallback).planTitle).toBe("sample-plan");
  });

  test("derives done, blocked, in-progress, and ready states", () => {
    const payload = buildTreePayload(
      input(
        {
          "api/01": task("api/01", "done"),
          "api/02": task("api/02", "todo", ["api/03"]),
          "api/03": task("api/03", "in-progress"),
          "api/04": task("api/04", "todo", ["api/01"]),
        },
        ["api"],
      ),
    );

    expect(payload.tasks.map((view) => view.state)).toEqual([
      "done",
      "blocked",
      "in-progress",
      "ready",
    ]);
  });

  test("lists unfinished dependencies in blockedBy", () => {
    const payload = buildTreePayload(
      input(
        {
          "api/01": task("api/01", "done"),
          "api/02": task("api/02", "todo"),
          "ui/01": task("ui/01", "todo", ["api/01", "api/02"]),
        },
        ["api", "ui"],
      ),
    );

    expect(payload.tasks.find((view) => view.ref === "ui/01")?.blockedBy)
      .toEqual(["api/02"]);
  });

  test("tallies every task state", () => {
    const payload = buildTreePayload(
      input(
        {
          "api/01": task("api/01", "done"),
          "api/02": task("api/02", "blocked"),
          "api/03": task("api/03", "in-progress"),
          "api/04": task("api/04"),
        },
        ["api"],
      ),
    );

    expect(payload.counts).toEqual({
      total: 4,
      done: 1,
      inProgress: 1,
      ready: 1,
      blocked: 1,
    });
  });
});
