import { describe, expect, test } from "bun:test";
import type { FleetRow } from "./fleet";
import type { AgentUsage, TokenCounts } from "./usage-types";
import { addCounts, attributeUsage } from "./usage-attribute";

function counts(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): TokenCounts {
  return { input, output, cacheRead, cacheWrite };
}

function row(overrides: Partial<FleetRow> & { key: string }): FleetRow {
  return {
    label: overrides.key,
    role: "dev",
    status: "finished",
    ...overrides,
  };
}

function agent(overrides: Partial<AgentUsage> & { file: string }): AgentUsage {
  return {
    task: "work/01",
    role: "dev",
    attempt: 1,
    startedAt: "2026-08-28T00:00:00.000Z",
    models: ["claude-haiku-4-5-20251001"],
    counts: counts(1, 1),
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function sumRollupByTask(byTask: Record<string, TokenCounts>): TokenCounts {
  const total = counts(0, 0, 0, 0);
  for (const value of Object.values(byTask)) addCounts(total, value);
  return total;
}

describe("addCounts", () => {
  test("sums all four fields into the accumulator", () => {
    const into = counts(1, 2, 3, 4);
    addCounts(into, counts(10, 20, 30, 40));
    expect(into).toEqual(counts(11, 22, 33, 44));
  });
});

describe("attributeUsage — pairing", () => {
  test("pairs a single row to a single agent of the same identity", () => {
    const rows = [
      row({
        key: "dev:work/01#1",
        ref: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
      }),
    ];
    const agents = [
      agent({
        file: "/a1.jsonl",
        task: "work/01",
        role: "dev",
        attempt: 1,
        counts: counts(5, 6, 7, 8),
      }),
    ];

    const { rows: outRows } = attributeUsage(rows, agents);

    expect(outRows[0]!.usage).toEqual(counts(5, 6, 7, 8));
  });

  test("does not pair rows and agents of different identities", () => {
    const rows = [
      row({
        key: "dev:work/01#1",
        ref: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
      }),
    ];
    const agents = [
      agent({ file: "/a1.jsonl", task: "work/02", role: "dev", attempt: 1 }),
    ];

    const { rows: outRows, rollup } = attributeUsage(rows, agents);

    expect(outRows[0]!.usage).toBeUndefined();
    // Still counted toward the rollup even though it never paired to a row.
    expect(rollup.byTask["work/02"]).toEqual(agents[0]!.counts);
  });

  test("a 5x5 group pairs by nearest start time, not by array order", () => {
    // Row start times, in ascending order: 0, 10, 20, 30, 40 (seconds).
    const base = Date.parse("2026-08-28T00:00:00.000Z");
    const rowTimes = [0, 10, 20, 30, 40];
    const rows = rowTimes.map((s, i) =>
      row({
        key: `row-${i}`,
        ref: "scout",
        role: "scout",
        startedAt: new Date(base + s * 1000).toISOString(),
      }),
    );

    // Agents deliberately listed out of order relative to their true nearest
    // row, so array-order pairing would produce a different (wrong) result.
    const agentTimes = [40, 0, 30, 10, 20];
    const agents = agentTimes.map((s, i) =>
      agent({
        file: `/agent-${i}.jsonl`,
        task: "scout",
        role: "scout",
        attempt: undefined,
        startedAt: new Date(base + s * 1000).toISOString(),
        counts: counts(i + 1, i + 1),
      }),
    );

    const { rows: outRows } = attributeUsage(rows, agents);

    // Each row's usage must match the agent whose start time equals its own,
    // not the agent that happens to share its array index.
    for (let i = 0; i < outRows.length; i++) {
      const expectedAgentIndex = agentTimes.indexOf(rowTimes[i]!);
      expect(outRows[i]!.usage).toEqual(agents[expectedAgentIndex]!.counts);
    }
  });

  test("more agents than rows leaves the surplus agent unpaired without throwing", () => {
    const rows = [
      row({
        key: "r1",
        ref: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
      }),
    ];
    const agents = [
      agent({
        file: "/a1.jsonl",
        task: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
      }),
      agent({
        file: "/a2.jsonl",
        task: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:05:00.000Z",
      }),
    ];

    expect(() => attributeUsage(rows, agents)).not.toThrow();
    const { rows: outRows, rollup } = attributeUsage(rows, agents);
    expect(outRows).toHaveLength(1);
    expect(outRows[0]!.usage).toBeDefined();
    // Both agents still count toward the rollup regardless of pairing.
    expect(rollup.agentCount).toBe(2);
  });

  test("more rows than agents leaves the surplus row unpaired without inventing a partner", () => {
    const rows = [
      row({
        key: "r1",
        ref: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
      }),
      row({
        key: "r2",
        ref: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:05:00.000Z",
      }),
    ];
    const agents = [
      agent({
        file: "/a1.jsonl",
        task: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
      }),
    ];

    const { rows: outRows } = attributeUsage(rows, agents);

    const paired = outRows.filter((r) => r.usage !== undefined);
    const unpaired = outRows.filter((r) => r.usage === undefined);
    expect(paired).toHaveLength(1);
    expect(unpaired).toHaveLength(1);
    expect(unpaired[0]!.usage).toBeUndefined();
  });

  test("an unpaired row's usage is undefined, never a zeroed object", () => {
    const rows = [
      row({
        key: "r1",
        ref: "ghost",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
      }),
    ];
    const { rows: outRows } = attributeUsage(rows, []);
    expect(outRows[0]!.usage).toBeUndefined();
    expect("usage" in outRows[0]!).toBe(false);
  });

  test("candidates missing a timestamp on either side pair last, in stable order", () => {
    const rows = [
      row({
        key: "no-ts-row",
        ref: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: undefined,
      }),
      row({
        key: "with-ts-row",
        ref: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
      }),
    ];
    const agents = [
      agent({
        file: "/with-ts.jsonl",
        task: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
        counts: counts(1, 1),
      }),
      agent({
        file: "/no-ts.jsonl",
        task: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: null,
        counts: counts(2, 2),
      }),
    ];

    const { rows: outRows } = attributeUsage(rows, agents);

    const withTsRow = outRows.find((r) => r.key === "with-ts-row")!;
    const noTsRow = outRows.find((r) => r.key === "no-ts-row")!;
    // The timestamped pair wins the nearest-time pass; the two leftovers with
    // no usable timestamp pair only afterward.
    expect(withTsRow.usage).toEqual(counts(1, 1));
    expect(noTsRow.usage).toEqual(counts(2, 2));
  });

  test("repeated calls on a timestamp tie return byte-identical output", () => {
    const ts = "2026-08-28T00:00:00.000Z";
    const rows = [
      row({
        key: "row-b",
        ref: "review",
        role: "review",
        attempt: 1,
        startedAt: ts,
      }),
      row({
        key: "row-a",
        ref: "review",
        role: "review",
        attempt: 1,
        startedAt: ts,
      }),
    ];
    const agents = [
      agent({
        file: "/z.jsonl",
        task: "review",
        role: "review",
        attempt: 1,
        startedAt: ts,
        counts: counts(1, 1),
      }),
      agent({
        file: "/a.jsonl",
        task: "review",
        role: "review",
        attempt: 1,
        startedAt: ts,
        counts: counts(2, 2),
      }),
    ];

    const first = attributeUsage(rows, agents);
    const second = attributeUsage(rows, agents);

    expect(first).toEqual(second);
  });
});

describe("attributeUsage — rollup", () => {
  test("both empty inputs produce an empty rollup", () => {
    const { rows, rollup } = attributeUsage([], []);
    expect(rows).toEqual([]);
    expect(rollup).toEqual({
      byTask: {},
      unattributed: counts(0, 0, 0, 0),
      totals: counts(0, 0, 0, 0),
      agentCount: 0,
    });
  });

  test("conservation invariant holds across paired, unpaired, and null-task agents", () => {
    const rows = [
      row({
        key: "r1",
        ref: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
      }),
    ];
    const agents = [
      agent({
        file: "/paired.jsonl",
        task: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
        counts: counts(10, 20, 30, 40),
      }),
      agent({
        file: "/unpaired.jsonl",
        task: "work/02",
        role: "dev",
        attempt: 3,
        startedAt: "2026-08-28T01:00:00.000Z",
        counts: counts(1, 2, 3, 4),
      }),
      agent({
        file: "/unknown-role.jsonl",
        task: "work/03",
        role: null,
        attempt: undefined,
        startedAt: null,
        counts: counts(5, 5, 5, 5),
      }),
      agent({
        file: "/no-task.jsonl",
        task: null,
        role: "scout",
        attempt: undefined,
        startedAt: null,
        counts: counts(100, 200, 300, 400),
      }),
    ];

    const { rollup } = attributeUsage(rows, agents);

    const byTaskSum = sumRollupByTask(rollup.byTask);
    const grandTotal = counts(0, 0, 0, 0);
    addCounts(grandTotal, byTaskSum);
    addCounts(grandTotal, rollup.unattributed);

    expect(grandTotal).toEqual(rollup.totals);
    expect(rollup.agentCount).toBe(4);
    // A null role still belongs to a task total, so it is not unattributed.
    expect(rollup.byTask["work/03"]).toEqual(counts(5, 5, 5, 5));
    expect(rollup.unattributed).toEqual(counts(100, 200, 300, 400));
  });

  // Task refs are parsed out of a transcript prompt, so these two names can reach
  // the rollup's key space. On a plain object they resolve to an inherited value
  // instead of `undefined`, and the accumulator would then write onto
  // `Object.prototype` — NaN totals here and a polluted process everywhere else.
  test("a task ref named after a prototype key stays an ordinary task", () => {
    const agents = [
      agent({
        file: "/proto.jsonl",
        task: "__proto__",
        counts: counts(1, 2, 3, 4),
      }),
      agent({
        file: "/ctor.jsonl",
        task: "constructor",
        counts: counts(10, 20, 30, 40),
      }),
    ];

    const { rollup } = attributeUsage([], agents);

    expect(rollup.byTask["__proto__"]).toEqual(counts(1, 2, 3, 4));
    expect(rollup.byTask["constructor"]).toEqual(counts(10, 20, 30, 40));
    expect(rollup.totals).toEqual(counts(11, 22, 33, 44));
    expect(sumRollupByTask(rollup.byTask)).toEqual(rollup.totals);
    expect(({} as Record<string, unknown>).input).toBeUndefined();
  });
});

describe("attributeUsage — purity", () => {
  test("never mutates deep-frozen input rows or agents", () => {
    const rows = deepFreeze([
      row({
        key: "r1",
        ref: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
      }),
      row({
        key: "r2",
        ref: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:05:00.000Z",
      }),
    ]);
    const agents = deepFreeze([
      agent({
        file: "/a1.jsonl",
        task: "work/01",
        role: "dev",
        attempt: 1,
        startedAt: "2026-08-28T00:00:00.000Z",
      }),
    ]);

    expect(() => attributeUsage(rows, agents)).not.toThrow();

    const { rows: outRows } = attributeUsage(rows, agents);
    // The returned rows are new objects, not the frozen originals.
    expect(outRows[0]).not.toBe(rows[0]);
    expect("usage" in rows[0]!).toBe(false);
  });
});
