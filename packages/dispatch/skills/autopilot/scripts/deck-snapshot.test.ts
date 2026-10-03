import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeckSnapshot } from "../../../hooks/flightdeck/types.ts";
import { buildDeckSnapshot, latestPlan, layerByDepth } from "./deck-snapshot";
import type { FleetRow, TaskView } from "./fleet";
import type { TreePayload } from "./tree-api";

const SCRIPT = join(import.meta.dir, "deck-snapshot.ts");

function dep(ref: string, ...dependsOn: string[]) {
  return { ref, dependsOn };
}

function view(
  ref: string,
  state: TaskView["state"],
  dependsOn: string[] = [],
  overrides: Partial<TaskView> = {},
): TaskView {
  const [bucket, nn] = ref.split("/");
  return {
    ref,
    bucket,
    nn,
    title: `Task ${ref}`,
    status: null,
    state,
    invalidReason: null,
    blockedBy: [],
    dependsOn,
    blocks: [],
    finalReview: false,
    attempts: 0,
    latestScore: null,
    ...overrides,
  };
}

function payload(
  tasks: TaskView[],
  overrides: Partial<TreePayload> = {},
): TreePayload {
  return {
    deckSource: "tasks",
    slug: "sample",
    planTitle: "Sample Plan",
    repo: "repo",
    buckets: [...new Set(tasks.map((task) => task.bucket))],
    tasks,
    counts: {
      total: tasks.length,
      done: tasks.filter((t) => t.state === "done").length,
      inProgress: tasks.filter((t) => t.state === "in-progress").length,
      ready: tasks.filter((t) => t.state === "ready").length,
      blocked: tasks.filter((t) => t.state === "blocked").length,
      invalid: tasks.filter((t) => t.state === "invalid").length,
    },
    waves: { current: 0, remaining: 0, sizes: [], unschedulable: [] },
    errors: [],
    ...overrides,
  };
}

function row(overrides: Partial<FleetRow>): FleetRow {
  return {
    identity: "id",
    key: "key",
    label: "agent",
    role: "dev",
    status: "in-flight",
    ...overrides,
  };
}

function snapshot(tasks: TaskView[], fleet: FleetRow[] = []) {
  return buildDeckSnapshot({ plan: "/plan", payload: payload(tasks), fleet });
}

describe("layerByDepth", () => {
  test("a chain takes one wave per link", () => {
    expect(layerByDepth([dep("a"), dep("b", "a"), dep("c", "b")])).toEqual({
      waves: [["a"], ["b"], ["c"]],
      unschedulable: [],
    });
  });

  test("a diamond shares its middle wave, in input order", () => {
    expect(
      layerByDepth([
        dep("a"),
        dep("b", "a"),
        dep("c", "a"),
        dep("d", "b", "c"),
      ]),
    ).toEqual({ waves: [["a"], ["b", "c"], ["d"]], unschedulable: [] });
  });

  test("depth comes from the deepest dependency, regardless of input order", () => {
    expect(
      layerByDepth([dep("d", "b", "a"), dep("b", "a"), dep("a")]).waves,
    ).toEqual([["a"], ["b"], ["d"]]);
  });

  test("a dangling dependency sends the task and its dependents to unschedulable", () => {
    expect(
      layerByDepth([
        dep("a"),
        dep("b", "a"),
        dep("c", "a"),
        dep("d", "b", "c"),
        dep("f", "e"),
        dep("e", "missing"),
      ]),
    ).toEqual({
      waves: [["a"], ["b", "c"], ["d"]],
      unschedulable: ["e", "f"],
    });
  });

  test("a 2-cycle and everything depending on it is unschedulable", () => {
    expect(
      layerByDepth([dep("z", "x"), dep("y", "x"), dep("x", "y"), dep("a")]),
    ).toEqual({ waves: [["a"]], unschedulable: ["x", "y", "z"] });
  });

  test("a self-dependency is a cycle", () => {
    expect(layerByDepth([dep("a", "a")])).toEqual({
      waves: [],
      unschedulable: ["a"],
    });
  });

  test("empty input has no waves", () => {
    expect(layerByDepth([])).toEqual({ waves: [], unschedulable: [] });
  });
});

describe("buildDeckSnapshot", () => {
  test("done tasks keep their wave", () => {
    const deck = snapshot([
      view("api/01", "done"),
      view("api/02", "done", ["api/01"]),
      view("ui/01", "ready", ["api/02"]),
    ]);
    expect(deck.waves).toEqual([["api/01"], ["api/02"], ["ui/01"]]);
    expect(deck.currentWave).toBe(3);
  });

  test("copies identification, counts, and the error count", () => {
    const tasks = [
      view("api/01", "done"),
      view("api/02", "in-progress"),
      view("ui/01", "blocked", ["api/02"]),
      view("ui/02", "invalid"),
      view("ui/03", "ready"),
    ];
    const deck = buildDeckSnapshot({
      plan: "/abs/plan",
      payload: payload(tasks, {
        deckSource: "graph",
        errors: [
          { file: "f", bucket: "", reason: "r1" },
          { file: "f", bucket: "", reason: "r2" },
        ],
      }),
      fleet: [],
    });
    expect(deck.deckSource).toBe("graph");
    expect(deck.plan).toBe("/abs/plan");
    expect(deck.slug).toBe("sample");
    expect(deck.planTitle).toBe("Sample Plan");
    expect(deck.counts).toEqual({
      total: 5,
      done: 1,
      inProgress: 1,
      ready: 1,
      blocked: 1,
      invalid: 1,
    });
    expect(deck.errors).toBe(2);
  });

  test("buckets follow payload order and tally done of total, empty buckets included", () => {
    const deck = buildDeckSnapshot({
      plan: "/plan",
      payload: payload(
        [
          view("api/01", "done"),
          view("api/02", "ready"),
          view("ui/01", "done"),
        ],
        { buckets: ["ui", "empty", "api"] },
      ),
      fleet: [],
    });
    expect(deck.buckets).toEqual([
      { name: "ui", done: 1, total: 1 },
      { name: "empty", done: 0, total: 0 },
      { name: "api", done: 1, total: 2 },
    ]);
  });

  test("currentWave is the lowest wave holding a non-done task", () => {
    const deck = snapshot([
      view("a/01", "done"),
      view("a/02", "in-progress", ["a/01"]),
      view("a/03", "done", ["a/01"]),
      view("a/04", "blocked", ["a/02"]),
    ]);
    expect(deck.currentWave).toBe(2);
  });

  test("currentWave is null when every task is done", () => {
    const deck = snapshot([
      view("a/01", "done"),
      view("a/02", "done", ["a/01"]),
    ]);
    expect(deck.currentWave).toBeNull();
  });

  test("currentWave is null for an empty tree", () => {
    const deck = snapshot([]);
    expect(deck.currentWave).toBeNull();
    expect(deck.waves).toEqual([]);
    expect(deck.tasks).toEqual({});
  });

  test("currentWave is null for a pure 2-cycle tree", () => {
    const deck = snapshot([
      view("a/01", "blocked", ["a/02"]),
      view("a/02", "blocked", ["a/01"]),
    ]);
    expect(deck.currentWave).toBeNull();
    expect(deck.unschedulable).toEqual(["a/01", "a/02"]);
  });

  test("currentWave is null when only a dangling-dependency task is left", () => {
    const deck = snapshot([
      view("a/01", "done"),
      view("a/02", "done", ["a/01"]),
      view("b/01", "blocked", ["gone/01"]),
    ]);
    expect(deck.currentWave).toBeNull();
    expect(deck.unschedulable).toEqual(["b/01"]);
  });

  test("score maps to weighted/threshold/passed, and null stays null", () => {
    const deck = snapshot([
      view("a/01", "done", [], {
        attempts: 2,
        latestScore: {
          weighted: 4.4,
          threshold: 4,
          passOp: ">",
          passed: true,
          hardFailed: false,
          breakdown: [{ name: "Correctness", weight: 3, score: 5 }],
          rationale: "fine",
        },
      }),
      view("a/02", "ready", ["a/01"]),
    ]);
    expect(deck.tasks["a/01"]).toEqual({
      ref: "a/01",
      title: "Task a/01",
      state: "done",
      attempts: 2,
      score: { weighted: 4.4, threshold: 4, passed: true },
      time: null,
      tokens: null,
    });
    expect(deck.tasks["a/02"]).toEqual({
      ref: "a/02",
      title: "Task a/02",
      state: "ready",
      attempts: 0,
      score: null,
      time: null,
      tokens: null,
    });
  });

  test("agents keep in-flight rows only, oldest first, unstarted last, absent fields null", () => {
    const deck = snapshot(
      [view("a/01", "in-progress")],
      [
        row({
          label: "late",
          startedAt: "2026-10-04T10:05:00Z",
          ref: "a/01",
          attempt: 2,
          role: "judge",
        }),
        row({
          label: "finished",
          status: "finished",
          startedAt: "2026-10-04T09:00:00Z",
        }),
        row({ label: "unstarted", role: "unknown" }),
        row({
          label: "abandoned",
          status: "abandoned",
          startedAt: "2026-10-04T09:00:00Z",
        }),
        row({ label: "early", startedAt: "2026-10-04T10:00:00Z" }),
      ],
    );
    expect(deck.agents).toEqual([
      {
        role: "dev",
        ref: null,
        attempt: null,
        label: "early",
        startedAt: "2026-10-04T10:00:00Z",
      },
      {
        role: "judge",
        ref: "a/01",
        attempt: 2,
        label: "late",
        startedAt: "2026-10-04T10:05:00Z",
      },
      {
        role: "unknown",
        ref: null,
        attempt: null,
        label: "unstarted",
        startedAt: null,
      },
    ]);
  });

  test("crew keeps the latest 3 taskless rows of any status, newest first", () => {
    const deck = snapshot(
      [view("a/01", "in-progress")],
      [
        row({ label: "scout-wave-1", role: "scout", ref: "scout", status: "finished", startedAt: "2026-10-04T10:00:00Z", elapsedMs: 8000 }),
        row({ label: "dev-a", ref: "a/01", startedAt: "2026-10-04T10:00:05Z" }),
        row({ label: "commit-wave-1", role: "commit", ref: "commit", status: "finished", startedAt: "2026-10-04T10:01:00Z", elapsedMs: 12000 }),
        row({ label: "scout-wave-2", role: "scout", ref: "scout", status: "abandoned", startedAt: "2026-10-04T10:02:00Z" }),
        row({ label: "scout-wave-3", role: "scout", ref: "scout", startedAt: "2026-10-04T10:03:00Z" }),
      ],
    );
    expect(deck.crew).toEqual([
      { role: "scout", label: "scout-wave-3", status: "in-flight", startedAt: "2026-10-04T10:03:00Z", elapsedMs: null },
      { role: "scout", label: "scout-wave-2", status: "abandoned", startedAt: "2026-10-04T10:02:00Z", elapsedMs: null },
      { role: "commit", label: "commit-wave-1", status: "finished", startedAt: "2026-10-04T10:01:00Z", elapsedMs: 12000 },
    ]);
  });

  test("task time spans its first start to its last finish, open while an agent runs", () => {
    const deck = snapshot(
      [view("a/01", "done"), view("a/02", "in-progress"), view("a/03", "ready")],
      [
        row({ ref: "a/01", status: "finished", startedAt: "2026-10-04T10:00:00Z", elapsedMs: 60_000 }),
        row({ ref: "a/01", status: "finished", startedAt: "2026-10-04T10:00:30Z", elapsedMs: 90_000 }),
        row({ ref: "a/02", status: "finished", startedAt: "2026-10-04T10:05:00Z", elapsedMs: 5_000 }),
        row({ ref: "a/02", startedAt: "2026-10-04T10:06:00Z" }),
      ],
    );
    expect(deck.tasks["a/01"].time).toEqual({ startedAt: "2026-10-04T10:00:00.000Z", endedAt: "2026-10-04T10:02:00.000Z" });
    expect(deck.tasks["a/02"].time).toEqual({ startedAt: "2026-10-04T10:05:00.000Z", endedAt: null });
    expect(deck.tasks["a/03"].time).toBeNull();
  });

  test("tokens ride only done tasks, and only when usage was read", () => {
    const tasks = [view("a/01", "done"), view("a/02", "in-progress")];
    const usage = new Map([["a/01", 1234], ["a/02", 99]]);
    const read = buildDeckSnapshot({ plan: "/plan", payload: payload(tasks), fleet: [], usage });
    expect(read.tasks["a/01"].tokens).toBe(1234);
    expect(read.tasks["a/02"].tokens).toBeNull();
    expect(snapshot(tasks).tasks["a/01"].tokens).toBeNull();
  });
});

const KEYS: (keyof DeckSnapshot)[] = [
  "deckSource",
  "plan",
  "slug",
  "planTitle",
  "counts",
  "buckets",
  "waves",
  "unschedulable",
  "currentWave",
  "tasks",
  "agents",
  "crew",
  "errors",
];

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deck-snapshot-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function run(...args: string[]) {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function taskFile(
  id: string,
  title: string,
  dependsOn: string,
  status: string,
) {
  return `# ${id}: ${title}\n\n> **Depends on**: ${dependsOn}\n> **Status**: ${status}\n\n## Goal\n\nx\n`;
}

async function writeRun(plan: string, lines: object[]) {
  await mkdir(join(plan, ".flightlog"), { recursive: true });
  const file = join(plan, ".flightlog", "run.jsonl");
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

describe("CLI", () => {
  test("prints a tasks-tree snapshot with every contract key", async () => {
    const plan = join(await tempDir(), "my-plan");
    await mkdir(join(plan, "tasks", "api"), { recursive: true });
    await writeFile(
      join(plan, "tasks", "api", "01-build.md"),
      taskFile("API-01", "Build", "none", "in-progress"),
    );
    await writeFile(
      join(plan, "tasks", "api", "02-ship.md"),
      taskFile("API-02", "Ship", "api/01", "todo"),
    );
    await writeRun(plan, [
      {
        kind: "note",
        ts: "2026-10-04T10:00:00Z",
        task: "api/01",
        role: "dev",
        attempt: 1,
        agentLabel: "dev:api/01#1",
        phase: "start",
        message: "start",
      },
    ]);

    const { stdout, code } = await run(plan);
    expect(code).toBe(0);
    const deck = JSON.parse(stdout) as DeckSnapshot;
    expect(Object.keys(deck).sort()).toEqual([...KEYS].sort());
    expect(deck.deckSource).toBe("tasks");
    expect(deck.plan).toBe(plan);
    expect(deck.slug).toBe("my-plan");
    expect(deck.waves).toEqual([["api/01"], ["api/02"]]);
    expect(deck.currentWave).toBe(1);
    expect(deck.agents).toHaveLength(1);
    expect(deck.agents[0]).toMatchObject({ ref: "api/01", attempt: 1 });
  });

  test("prints a graph snapshot", async () => {
    const plan = await tempDir();
    await writeFile(
      join(plan, "graph.json"),
      JSON.stringify({
        version: 1,
        title: "Graph Run",
        repoRoot: "/repo",
        lanes: ["build"],
        nodes: [
          { ref: "build/01", lane: "build", title: "One" },
          {
            ref: "build/02",
            lane: "build",
            title: "Two",
            dependsOn: ["build/01"],
          },
        ],
      }),
    );

    const { stdout, code } = await run(plan);
    expect(code).toBe(0);
    const deck = JSON.parse(stdout) as DeckSnapshot;
    expect(deck.deckSource).toBe("graph");
    expect(deck.planTitle).toBe("Graph Run");
    expect(deck.waves).toEqual([["build/01"], ["build/02"]]);
  });

  test("exits 1 on a dir with neither tasks/ nor graph.json", async () => {
    const plan = await tempDir();
    const { stdout, stderr, code } = await run(plan);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.trim()).toBe(`no tasks/ or graph.json in ${plan}`);
  });

  test("--latest picks the plan with the newest run log", async () => {
    const root = await tempDir();
    const older = join(root, "docs", "older");
    const newer = join(root, "docs", "newer");
    await mkdir(join(root, "docs", "unflown"), { recursive: true });
    const olderLog = await writeRun(older, []);
    const newerLog = await writeRun(newer, []);
    await utimes(olderLog, 2_000_000, 2_000_000);
    await utimes(newerLog, 1_000_000, 1_000_000);

    expect(await latestPlan(root)).toBe(older);
    const { stdout, code } = await run("--latest", root);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ plan: older });

    await utimes(newerLog, 3_000_000, 3_000_000);
    expect(await latestPlan(root)).toBe(newer);
  });

  test("--latest exits 3 when no run exists", async () => {
    const root = await tempDir();
    expect(await latestPlan(root)).toBeNull();
    await mkdir(join(root, "docs", "unflown"), { recursive: true });
    expect(await latestPlan(root)).toBeNull();

    const { stdout, stderr, code } = await run("--latest", root);
    expect(code).toBe(3);
    expect(stdout).toBe("");
    expect(stderr.trim()).toBe(`no flightplan run under ${root}/docs`);
  });
});
