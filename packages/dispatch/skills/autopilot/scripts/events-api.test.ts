import { describe, expect, test } from "bun:test";
import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import {
  createDebouncer,
  decodeLogChunk,
  eventsHandler,
  formatFleetFrame,
  newFrameMemory,
  nextFleetFrame,
} from "./events-api";
import { projectSlug, type TranscriptSource } from "./usage-source";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FleetSnapshot } from "./events-api";
import { emptyCounts, type AgentUsage, type TokenCounts } from "./usage-types";

const entry: FlightlogEntry = {
  kind: "note",
  ts: "2026-08-01T00:00:00.000Z",
  task: "server/05",
  role: "dev",
  phase: "start",
  message: "開始",
};

function counts(input: number): TokenCounts {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function agent(overrides: Partial<AgentUsage> = {}): AgentUsage {
  return {
    file: "/tmp/agent-1.jsonl",
    task: "server/05",
    role: "dev",
    attempt: undefined,
    startedAt: "2026-08-01T00:00:00.000Z",
    lastAt: "2026-08-01T00:00:00.000Z",
    relayDirs: [],
    externalDriver: false,
    models: ["claude-haiku-4-5-20251001"],
    counts: counts(10),
    ...overrides,
  };
}

function judged(rationale: string): FlightlogEntry {
  return {
    kind: "score",
    ts: "2026-08-01T00:01:00.000Z",
    task: "server/05",
    attempt: 1,
    weighted: 4.5,
    passed: true,
    hardFailed: false,
    missing: [],
    threshold: 4,
    passOp: ">=",
    breakdown: [{ name: "Correctness", weight: 1, score: 4.5 }],
    rationale,
  };
}

function frameData(frame: string): Record<string, unknown> {
  return JSON.parse(frame.split("\n")[1]!.slice("data: ".length));
}

describe("formatFleetFrame", () => {
  test("carries an all-zero rollup when no agents are found", () => {
    const frame = formatFleetFrame([entry], true, []);
    const data = frameData(frame);

    expect(frame.startsWith("event: fleet\n")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(data).toEqual({
      rows: [
        {
          key: "server/05|dev|-",
          identity: "server/05|dev|-",
          label: "server/05|dev|-",
          role: "dev",
          ref: "server/05",
          status: "in-flight",
          startedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      entryCount: 1,
      logPresent: true,
      usage: {
        byTask: {},
        unattributed: emptyCounts(),
        totals: emptyCounts(),
        agentCount: 0,
        codexByTask: {},
        codexTotals: emptyCounts(),
        codexRunCount: 0,
      },
    });
  });

  test("attaches per-agent usage to the paired row and rolls it up", () => {
    const frame = formatFleetFrame([entry], true, [agent()]);
    const data = frameData(frame);

    expect((data.rows as Array<{ usage?: TokenCounts }>)[0]!.usage).toEqual(
      counts(10),
    );
    expect(data.usage).toEqual({
      byTask: { "server/05": counts(10) },
      unattributed: emptyCounts(),
      totals: counts(10),
      agentCount: 1,
      codexByTask: {},
      codexTotals: emptyCounts(),
      codexRunCount: 0,
    });
  });

  test("sends each judge rationale once per stream, outside the rows", () => {
    const score = judged("Long judge prose.");
    const memory = newFrameMemory();

    const first = frameData(formatFleetFrame([entry, score], true, [], memory));
    const rows = first.rows as Array<{ score?: { rationale?: string } }>;
    expect(rows.some((row) => row.score)).toBe(true);
    expect(rows.every((row) => row.score?.rationale === undefined)).toBe(true);
    expect(first.rationales).toEqual({
      "server/05|1|2026-08-01T00:01:00.000Z": "Long judge prose.",
    });

    const second = frameData(
      formatFleetFrame([entry, score], true, [], memory),
    );
    expect(second.rationales).toBeUndefined();
  });

  // A rewritten flightlog can keep a score's identity and change its prose.
  test("resends a rationale whose text changed under the same key", () => {
    const memory = newFrameMemory();
    nextFleetFrame([entry, judged("Original")], true, [], memory);

    const frame = nextFleetFrame(
      [entry, judged("Corrected")],
      true,
      [],
      memory,
    );

    expect(frameData(frame!).rationales).toEqual({
      "server/05|1|2026-08-01T00:01:00.000Z": "Corrected",
    });
  });

  test("skips an unchanged snapshot even after a frame that carried rationales", () => {
    const memory = newFrameMemory();
    expect(
      nextFleetFrame([entry, judged("Prose")], true, [], memory),
    ).toBeDefined();

    expect(
      nextFleetFrame([entry, judged("Prose")], true, [], memory),
    ).toBeUndefined();
  });

  test("excludes malformed and blank lines", () => {
    const decoded = decodeLogChunk(
      new TextDecoder(),
      new TextEncoder().encode(`\ninvalid\n${JSON.stringify(entry)}\n`),
      "",
    );

    expect(decoded.entries).toEqual([entry]);
    expect(decoded.partial).toBe("");
  });
});

describe("decodeLogChunk", () => {
  test("reassembles a UTF-8 character split across reads", () => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(entry)}\n`);
    const character = new TextEncoder().encode("開");
    const splitAt =
      bytes.findIndex((byte, index) =>
        bytes
          .slice(index, index + character.length)
          .every((candidate, offset) => candidate === character[offset]),
      ) + 1;
    const decoder = new TextDecoder();

    const first = decodeLogChunk(decoder, bytes.slice(0, splitAt), "");
    const second = decodeLogChunk(decoder, bytes.slice(splitAt), first.partial);

    expect(first.entries).toEqual([]);
    expect(second.entries).toEqual([entry]);
    expect(second.partial).toBe("");
  });
});

describe("createDebouncer", () => {
  test("coalesces a burst into one call", async () => {
    let calls = 0;
    const debounce = createDebouncer(() => {
      calls += 1;
    }, 20);

    debounce.schedule();
    debounce.schedule();
    debounce.schedule();
    await Bun.sleep(40);

    expect(calls).toBe(1);
    debounce.cancel();
  });
});

describe("eventsHandler", () => {
  test("degrades to an empty rollup, not a dropped frame, when the source throws", async () => {
    const throwingSource: TranscriptSource = {
      read() {
        throw new Error("boom");
      },
    };
    const controller = new AbortController();
    const request = new Request("http://localhost/api/events", {
      signal: controller.signal,
    });

    const response = eventsHandler(
      request,
      "/nonexistent/run.jsonl",
      "/nonexistent/plan",
      { source: throwingSource },
    );
    const reader = response.body!.getReader();

    try {
      const { value } = await reader.read();
      const frame = typeof value === "string" ? value : "";
      const data = frameData(frame);

      expect(frame.startsWith("event: fleet\n")).toBe(true);
      expect(frame.endsWith("\n\n")).toBe(true);
      expect(data.usage).toEqual({
        byTask: {},
        unattributed: emptyCounts(),
        totals: emptyCounts(),
        agentCount: 0,
        codexByTask: {},
        codexTotals: emptyCounts(),
        codexRunCount: 0,
      });
    } finally {
      controller.abort();
      await reader.cancel();
    }
  });

  // A transcript grows while its agent runs, but the flightlog does not move until
  // that agent ends. Scheduling a snapshot only on flightlog activity therefore
  // froze every in-flight row's token cell at its opening value, often for minutes.
  // Slow on purpose: it waits out the real poll interval rather than adding a
  // configuration seam nothing in production would ever set.
  test("refreshes usage on the poll cadence while the flightlog is silent", async () => {
    let reads = 0;
    const growingSource: TranscriptSource = {
      read() {
        reads += 1;
        return [agent({ counts: counts(reads * 10) })];
      },
    };
    const controller = new AbortController();
    const request = new Request("http://localhost/api/events", {
      signal: controller.signal,
    });

    const response = eventsHandler(
      request,
      "/nonexistent/run.jsonl",
      "/nonexistent/plan",
      { source: growingSource },
    );
    const reader = response.body!.getReader();

    try {
      const first = await reader.read();
      expect(frameData(String(first.value)).usage).toMatchObject({
        totals: counts(10),
      });

      const second = await reader.read();
      const totals = (
        frameData(String(second.value)).usage as { totals: TokenCounts }
      ).totals;
      expect(totals.input).toBeGreaterThan(10);
    } finally {
      controller.abort();
      await reader.cancel();
    }
  }, 10_000);

  // A finished run polls the same snapshot forever; resending it every 2s made the
  // browser parse ~400KB a frame for nothing. Slow for the same reason as above.
  test("skips a frame identical to the last one sent", async () => {
    const steadySource: TranscriptSource = { read: () => [agent()] };
    const controller = new AbortController();
    const request = new Request("http://localhost/api/events", {
      signal: controller.signal,
    });

    const response = eventsHandler(
      request,
      "/nonexistent/run.jsonl",
      "/nonexistent/plan",
      { source: steadySource },
    );
    const reader = response.body!.getReader();

    try {
      const first = await reader.read();
      expect(String(first.value).startsWith("event: fleet\n")).toBe(true);

      const next = await Promise.race([
        reader.read().then(() => "frame"),
        Bun.sleep(5_000).then(() => "silent"),
      ]);
      expect(next).toBe("silent");
    } finally {
      controller.abort();
      await reader.cancel();
    }
  }, 10_000);
});

describe("eventsHandler transcript membership", () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "events-membership-"));
    const planDir = join(root, "run");
    const repoRoot = join(root, "declared-repo");
    const projectsRoot = join(root, "projects");
    mkdirSync(planDir);
    const logPath = join(planDir, "run.jsonl");
    writeFileSync(
      logPath,
      [entry, { ...entry, task: "server/06" }]
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n",
    );
    for (const [id, input] of [
      ["old-id", 3],
      ["new-id", 7],
    ] as const) {
      const file = join(
        projectsRoot,
        projectSlug(repoRoot),
        "session",
        "subagents",
        "workflows",
        "wf_1",
        `agent-${id}.jsonl`,
      );
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        [
          {
            type: "user",
            timestamp: entry.ts,
            message: {
              content: `${planDir}/run.jsonl --task ${id === "old-id" ? "server/06" : "server/05"} --role dev run ${id} codex-run.ts`,
            },
          },
          {
            type: "assistant",
            timestamp: entry.ts,
            message: { model: "m", usage: { input_tokens: input } },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
    }
    return { root, planDir, repoRoot, projectsRoot, logPath };
  }

  function connect(
    f: ReturnType<typeof fixture>,
    options: NonNullable<Parameters<typeof eventsHandler>[3]> = {},
  ) {
    const controller = new AbortController();
    const response = eventsHandler(
      new Request("http://localhost/api/events", { signal: controller.signal }),
      f.logPath,
      f.planDir,
      {
        repoRoot: f.repoRoot,
        projectsRoot: f.projectsRoot,
        codexSource: { read: () => [] },
        ...options,
      },
    );
    const reader = response.body!.getReader();
    return {
      async read(): Promise<FleetSnapshot> {
        return frameData(String((await reader.read()).value)) as FleetSnapshot;
      },
      async close() {
        controller.abort();
        await reader.cancel();
      },
    };
  }

  function expectUsage(
    snapshot: FleetSnapshot,
    input: number,
    agentCount: number,
  ) {
    expect(snapshot.usage.totals).toEqual(counts(input));
    expect(snapshot.usage.agentCount).toBe(agentCount);
    const byTask: Record<string, TokenCounts> = {};
    if (input === 3 || agentCount === 2) byTask["server/06"] = counts(3);
    if (input === 7 || agentCount === 2) byTask["server/05"] = counts(7);
    if (input === 10 && agentCount === 1) byTask["server/05"] = counts(10);
    expect(snapshot.usage.byTask).toEqual(byTask);
    expect(snapshot.rows).toHaveLength(2);
    for (const row of snapshot.rows)
      expect(row.usage).toEqual(
        row.ref === undefined ? undefined : byTask[row.ref],
      );
  }

  test("uses the declared root for transcript discovery and the codex cwd join", async () => {
    const f = fixture();
    const stream = connect(f, {
      codexSource: {
        read: () => [
          {
            file: "/rollout.jsonl",
            cwd: f.repoRoot,
            startedAt: entry.ts,
            relayDir: null,
            originator: "codex_exec",
            model: null,
            counts: counts(42),
          },
        ],
      },
    });
    try {
      const snapshot = await stream.read();
      expectUsage(snapshot, 10, 2);
      expect(snapshot.usage.codexTotals).toEqual(counts(42));
      expect(
        snapshot.rows
          .filter((row) => row.codexUsage)
          .map((row) => row.codexUsage),
      ).toEqual([counts(42)]);
    } finally {
      await stream.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("handler: run id read from correct location (graph source)", async () => {
    const f = fixture();
    const logPath = join(f.planDir, ".flightlog", "run.jsonl");
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(
      logPath,
      [entry, { ...entry, task: "server/06" }]
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n",
    );
    // Production keeps run.id beside graph.json, one level above the flightlog.
    writeFileSync(join(f.planDir, "run.id"), "new-id\n");
    const stream = connect({ ...f, logPath }, { deckSource: "graph" });
    try {
      expectUsage(await stream.read(), 7, 1);
    } finally {
      await stream.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("graph identity appearing, changing, and disappearing updates one live connection", async () => {
    const f = fixture();
    const stream = connect(f, { deckSource: "graph" });
    try {
      expectUsage(await stream.read(), 0, 0);
      writeFileSync(join(f.planDir, "run.id"), " old-id\n");
      expectUsage(await stream.read(), 3, 1);
      writeFileSync(join(f.planDir, "run.id"), "new-id\n");
      expectUsage(await stream.read(), 7, 1);
      rmSync(join(f.planDir, "run.id"));
      expectUsage(await stream.read(), 0, 0);
    } finally {
      await stream.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 12_000);

  test.each(["", "   \n", "directory"])(
    "graph with absent content (%j) attributes nothing",
    async (content) => {
      const f = fixture();
      if (content === "directory") mkdirSync(join(f.planDir, "run.id"));
      else writeFileSync(join(f.planDir, "run.id"), content);
      const stream = connect(f, { deckSource: "graph" });
      try {
        expectUsage(await stream.read(), 0, 0);
      } finally {
        await stream.close();
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  test("tasks and the default source ignore run.id and preserve every figure", async () => {
    const f = fixture();
    const before = connect(f, { deckSource: "tasks" });
    try {
      const baseline = await before.read();
      expectUsage(baseline, 10, 2);
      writeFileSync(join(f.planDir, "run.id"), "new-id");
      for (const deckSource of ["tasks", undefined] as const) {
        const after = connect(f, { deckSource });
        try {
          expect(await after.read()).toEqual(baseline);
        } finally {
          await after.close();
        }
      }
    } finally {
      await before.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("keeps the transcript reader injection and passes the current graph identity", async () => {
    const f = fixture();
    writeFileSync(join(f.planDir, "run.id"), "new-id");
    const ids: Array<string | undefined> = [];
    const stream = connect(f, {
      deckSource: "graph",
      source: {
        read(runId?: string) {
          ids.push(runId);
          return [agent()];
        },
      },
    });
    try {
      expectUsage(await stream.read(), 10, 1);
      expect(ids).toEqual(["new-id"]);
    } finally {
      await stream.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
