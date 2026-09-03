import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import type { ParsedTask } from "../../flightplan/scripts/lib/parse-task";
import { buildTreePayload, type Loaded, repoName } from "./tree-api";

/** A body whose Verification gate box is still unticked. */
const UNTICKED_GATE = "## Verification\n\n- [ ] Run the suite\n";

function task(
  ref: string,
  status: ParsedTask["status"] = "todo",
  dependsOn: string[] = [],
  body = "",
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
    body,
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
    repo: "sample-repo",
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
      invalid: 0,
    });
  });

  test("carries the repo name", () => {
    expect(buildTreePayload(input()).repo).toBe("sample-repo");
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

    expect(
      payload.tasks.find((view) => view.ref === "ui/01")?.blockedBy,
    ).toEqual(["api/02"]);
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
      invalid: 0,
    });
  });

  test("counts a malformed completion as invalid, not as done", () => {
    const payload = buildTreePayload(
      input(
        {
          "api/01": task("api/01", "done", [], UNTICKED_GATE),
          "api/02": task("api/02", "todo", ["api/01"]),
        },
        ["api"],
      ),
    );

    expect(payload.counts).toEqual({
      total: 2,
      done: 0,
      inProgress: 0,
      ready: 0,
      blocked: 1,
      invalid: 1,
    });
    expect(payload.tasks.map((view) => view.state)).toEqual([
      "invalid",
      "blocked",
    ]);
    expect(payload.tasks[1].blockedBy).toEqual(["api/01"]);
  });

  test("summarizes the waves left, and which one is flying", () => {
    const payload = buildTreePayload(
      input(
        {
          "api/01": task("api/01", "done"),
          "api/02": task("api/02", "todo", ["api/01"]),
          "ui/01": task("ui/01", "todo", ["api/02"]),
        },
        ["api", "ui"],
        [
          {
            kind: "note",
            ts: "2026-01-01T00:00:00.000Z",
            task: "-",
            role: "scout",
            agentLabel: "scout-wave-2",
            phase: "start",
            message: "scouting",
          },
        ],
      ),
    );

    expect(payload.waves).toEqual({
      current: 2,
      remaining: 2,
      sizes: [1, 1],
      unschedulable: [],
    });
  });
});

describe("repoName", () => {
  function scratch(): string {
    return mkdtempSync(join(tmpdir(), "flightdeck-repo-"));
  }

  test("names the nearest repo above the plan", () => {
    const root = scratch();
    const repo = join(root, "my-repo");
    const plan = join(repo, "docs", "sample-plan");
    mkdirSync(plan, { recursive: true });
    mkdirSync(join(repo, ".git"));

    expect(repoName(plan)).toBe("my-repo");
  });

  test("accepts a worktree, where .git is a file", () => {
    const root = scratch();
    const repo = join(root, "linked-tree");
    const plan = join(repo, "docs", "sample-plan");
    mkdirSync(plan, { recursive: true });
    writeFileSync(join(repo, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");

    expect(repoName(plan)).toBe("linked-tree");
  });

  test("returns an empty name outside a repo", () => {
    const plan = join(scratch(), "docs", "sample-plan");
    mkdirSync(plan, { recursive: true });

    expect(repoName(plan)).toBe("");
  });
});
