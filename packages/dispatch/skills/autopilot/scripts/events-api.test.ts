import { describe, expect, test } from "bun:test";
import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import {
  createDebouncer,
  decodeLogChunk,
  eventsHandler,
  formatFleetFrame,
} from "./events-api";
import type { TranscriptSource } from "./usage-source";
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
    models: ["claude-haiku-4-5-20251001"],
    counts: counts(10),
    ...overrides,
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
    });
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
});
