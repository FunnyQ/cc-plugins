import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_MS } from "../../../shared/scripts/cockpit-trail";
import {
  planArchive,
  writePlan,
  type ArchiveTarget,
  type Assignment,
  type PlanDeps,
  type SourceBucket,
} from "./archive-plan";

const TRAIL_ROOT = "/project";
const NOW_MS = 2_000_000;

function sessionPath(
  sessionId: string,
  bucket: SourceBucket | ArchiveTarget,
): string {
  if (bucket === "inbox") {
    return join(TRAIL_ROOT, ".cockpit", "logs", `${sessionId}.jsonl`);
  }
  return join(TRAIL_ROOT, ".cockpit", "archive", bucket, `${sessionId}.jsonl`);
}

function deps(
  mtimes: Record<string, number | null>,
  existing: string[] = [],
): PlanDeps {
  const files = new Set(existing);
  return {
    nowMs: NOW_MS,
    mtimeOf: (path) => mtimes[path] ?? null,
    exists: (path) => files.has(path),
  };
}

describe("planArchive", () => {
  const staleBoundaryCases: {
    name: string;
    ageMs: number;
    outcome: "move" | "live";
  }[] = [
    { name: "exactly at the boundary", ageMs: STALE_MS, outcome: "move" },
    {
      name: "one millisecond newer than the boundary",
      ageMs: STALE_MS - 1,
      outcome: "live",
    },
    {
      name: "one millisecond older than the boundary",
      ageMs: STALE_MS + 1,
      outcome: "move",
    },
  ];

  for (const { name, ageMs, outcome } of staleBoundaryCases) {
    test(name, () => {
      const source = sessionPath("boundary", "inbox");
      const plan = planArchive(
        TRAIL_ROOT,
        [{ sessionId: "boundary", target: "done" }],
        deps({ [source]: NOW_MS - ageMs }),
      );

      expect(plan.moves).toHaveLength(outcome === "move" ? 1 : 0);
      expect(plan.refused.map(({ reason }) => reason)).toEqual(
        outcome === "live" ? ["live"] : [],
      );
    });
  }

  const transitionCases: {
    name: string;
    assignment: Assignment;
    outcome: "move" | "no-op";
  }[] = [
    {
      name: "inbox to done",
      assignment: { sessionId: "inbox-done", target: "done" },
      outcome: "move",
    },
    {
      name: "inbox to watch",
      assignment: { sessionId: "inbox-watch", target: "watch" },
      outcome: "move",
    },
    {
      name: "watch to done",
      assignment: {
        sessionId: "watch-done",
        from: "watch",
        target: "done",
      },
      outcome: "move",
    },
    {
      name: "watch to watch",
      assignment: {
        sessionId: "watch-watch",
        from: "watch",
        target: "watch",
      },
      outcome: "no-op",
    },
  ];

  for (const { name, assignment, outcome } of transitionCases) {
    test(name, () => {
      const fromBucket = assignment.from ?? "inbox";
      const source = sessionPath(assignment.sessionId, fromBucket);
      const plan = planArchive(
        TRAIL_ROOT,
        [assignment],
        deps({ [source]: NOW_MS - STALE_MS }),
      );

      if (outcome === "move") {
        expect(plan.moves).toEqual([
          {
            from: source,
            to: sessionPath(assignment.sessionId, assignment.target),
            target: assignment.target,
            fromBucket,
          },
        ]);
        expect(plan.refused).toEqual([]);
      } else {
        expect(plan.moves).toEqual([]);
        expect(plan.refused[0]?.reason).toBe("no-op");
      }
    });
  }

  const refusalCases: {
    name: string;
    assignment: Assignment;
    mtimes: Record<string, number | null>;
    existing?: string[];
    reason: "live" | "missing" | "collision" | "already-archived" | "no-op";
  }[] = [
    {
      name: "live source",
      assignment: { sessionId: "live", target: "done" },
      mtimes: { [sessionPath("live", "inbox")]: NOW_MS - 1_000 },
      reason: "live",
    },
    {
      name: "missing source",
      assignment: { sessionId: "missing", target: "watch" },
      mtimes: {},
      reason: "missing",
    },
    {
      name: "destination collision",
      assignment: { sessionId: "collision", target: "done" },
      mtimes: {
        [sessionPath("collision", "inbox")]: NOW_MS - STALE_MS,
      },
      existing: [sessionPath("collision", "done")],
      reason: "collision",
    },
    {
      name: "already archived in done",
      assignment: { sessionId: "settled", target: "done" },
      mtimes: {},
      existing: [sessionPath("settled", "done")],
      reason: "already-archived",
    },
    {
      name: "watched source remains watched",
      assignment: { sessionId: "watching", from: "watch", target: "watch" },
      mtimes: {
        [sessionPath("watching", "watch")]: NOW_MS - STALE_MS,
      },
      reason: "no-op",
    },
  ];

  for (const testCase of refusalCases) {
    test(`refuses ${testCase.name}`, () => {
      const plan = planArchive(
        TRAIL_ROOT,
        [testCase.assignment],
        deps(testCase.mtimes, testCase.existing),
      );

      expect(plan.moves).toEqual([]);
      expect(plan.refused).toHaveLength(1);
      expect(plan.refused[0]?.reason).toBe(testCase.reason);
      expect(plan.refused[0]?.detail.length).toBeGreaterThan(0);
    });
  }

  test("reports live age in seconds", () => {
    const source = sessionPath("young", "inbox");
    const plan = planArchive(
      TRAIL_ROOT,
      [{ sessionId: "young", target: "done" }],
      deps({ [source]: NOW_MS - 1_500 }),
    );

    expect(plan.refused[0]?.detail).toContain("1.5 seconds");
  });

  test("a repeated done assignment becomes already-archived", () => {
    const assignment: Assignment = { sessionId: "repeat", target: "done" };
    const source = sessionPath("repeat", "inbox");
    const first = planArchive(
      TRAIL_ROOT,
      [assignment],
      deps({ [source]: NOW_MS - STALE_MS }),
    );
    const second = planArchive(
      TRAIL_ROOT,
      [assignment],
      deps({}, [sessionPath("repeat", "done")]),
    );

    expect(first.moves).toHaveLength(1);
    expect(second.moves).toEqual([]);
    expect(second.refused[0]?.reason).toBe("already-archived");
  });

  test("uses the declared source when a session appears in two buckets", () => {
    const inbox = sessionPath("duplicate", "inbox");
    const watch = sessionPath("duplicate", "watch");
    const plan = planArchive(
      TRAIL_ROOT,
      [{ sessionId: "duplicate", from: "watch", target: "done" }],
      deps({
        [inbox]: NOW_MS - STALE_MS,
        [watch]: NOW_MS - STALE_MS,
      }),
    );

    expect(plan.moves[0]?.from).toBe(watch);
    expect(plan.moves[0]?.fromBucket).toBe("watch");
  });
});

describe("CLI", () => {
  const script = join(import.meta.dir, "archive-plan.ts");
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function run(cwd: string, assignments: Assignment[]) {
    const file = join(cwd, "assignments.json");
    writeFileSync(file, JSON.stringify(assignments));
    return spawnSync(process.execPath, [script, "--assignments", file], {
      cwd,
      encoding: "utf8",
    });
  }

  function scratch(): string {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "archive-plan-")),
    );
    directories.push(directory);
    return directory;
  }

  test("exits non-zero and prints no plan when cwd holds no trail", () => {
    const result = run(scratch(), [{ sessionId: "a", target: "done" }]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(".cockpit");
  });

  test("exits non-zero when every session is missing from the trail", () => {
    const directory = scratch();
    mkdirSync(join(directory, ".cockpit", "logs"), { recursive: true });

    const result = run(directory, [
      { sessionId: "a", target: "done" },
      { sessionId: "b", target: "done" },
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  test("prints an empty plan for an empty assignment list", async () => {
    const directory = scratch();
    mkdirSync(join(directory, ".cockpit", "logs"), { recursive: true });

    const result = run(directory, []);

    expect(result.status).toBe(0);
    const plan = JSON.parse(await readFile(result.stdout.trim(), "utf8"));
    expect(plan.moves).toEqual([]);
  });

  test("prints the plan path when the trail holds the sessions", () => {
    const directory = scratch();
    const logs = join(directory, ".cockpit", "logs");
    mkdirSync(logs, { recursive: true });
    const log = join(logs, "a.jsonl");
    writeFileSync(log, "{}\n");
    const date = new Date(Date.now() - STALE_MS - 1_000);
    utimesSync(log, date, date);

    const result = run(directory, [{ sessionId: "a", target: "done" }]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().startsWith("/tmp/chronicle/adr/")).toBe(true);
  });
});

describe("writePlan", () => {
  test("round-trips the plan without an envelope", async () => {
    const plan = {
      trailRoot: TRAIL_ROOT,
      moves: [
        {
          from: sessionPath("round-trip", "inbox"),
          to: sessionPath("round-trip", "done"),
          target: "done" as const,
          fromBucket: "inbox" as const,
        },
      ],
      refused: [],
    };

    const outputPath = await writePlan(plan);
    const parsed = JSON.parse(await readFile(outputPath, "utf8"));

    expect(outputPath.startsWith("/tmp/chronicle/adr/")).toBe(true);
    expect(parsed).toEqual(plan);
    expect(Object.keys(parsed)).toEqual(["trailRoot", "moves", "refused"]);
  });
});
