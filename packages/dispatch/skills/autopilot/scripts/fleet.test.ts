import { describe, expect, test } from "bun:test";
import type { ParsedTask } from "../../flightplan/scripts/lib/parse-task";
import type {
  FlightlogEntry,
  ScoreEntry,
} from "../../flightplan/scripts/lib/flightlog";
import { aggregateFleet, deriveTaskViews, parseAgentLabel } from "./fleet";

const note = (
  task: string,
  role: string,
  attempt: number | undefined,
  ts: string,
  phase?: "start" | "end",
  agentLabel?: string,
): FlightlogEntry => ({
  kind: "note",
  task,
  role,
  attempt,
  ts,
  phase,
  agentLabel,
  message: `${role} message`,
});

const score = (task: string, attempt: number, ts: string): ScoreEntry => ({
  kind: "score",
  task,
  attempt,
  ts,
  agentLabel: `judge:${task}#${attempt}`,
  weighted: 4.5 + attempt / 10,
  passed: true,
  hardFailed: false,
  missing: [],
  threshold: 4.2,
  passOp: ">",
  breakdown: [{ name: "Correctness", weight: 2, score: 5 }],
});

const task = (
  ref: string,
  status: ParsedTask["status"] = "todo",
  dependsOn: string[] = [],
): ParsedTask => {
  const [bucket, nn] = ref.split("/");
  return {
    bucket,
    nn,
    title: ref,
    h1: `# ${bucket.toUpperCase()}-${nn}: ${ref}`,
    requiredReading: [],
    dependsOn: dependsOn.map((dependency) => {
      const [dependencyBucket, dependencyNn] = dependency.split("/");
      return { bucket: dependencyBucket, nn: dependencyNn };
    }),
    blocks: [{ bucket: "next", nn: "01" }],
    status,
    finalReview: false,
    sections: [],
    body: "",
    rubric: null,
  };
};

describe("parseAgentLabel", () => {
  test.each([
    ["scout-wave-3", { role: "scout", wave: 3, raw: "scout-wave-3" }],
    [
      "dev:ui/03#2",
      { role: "dev", ref: "ui/03", attempt: 2, raw: "dev:ui/03#2" },
    ],
    [
      "dev-codex:ui/03#2",
      { role: "dev", ref: "ui/03", attempt: 2, raw: "dev-codex:ui/03#2" },
    ],
    [
      "verify:ui/03#2",
      { role: "verify", ref: "ui/03", attempt: 2, raw: "verify:ui/03#2" },
    ],
    [
      "judge:ui/03#2",
      { role: "judge", ref: "ui/03", attempt: 2, raw: "judge:ui/03#2" },
    ],
    [
      "review:reuse#1",
      { role: "review", lens: "reuse", attempt: 1, raw: "review:reuse#1" },
    ],
    [
      "fix:ui/03#1",
      { role: "fix", ref: "ui/03", attempt: 1, raw: "fix:ui/03#1" },
    ],
    ["done:ui/03", { role: "done", ref: "ui/03", raw: "done:ui/03" }],
    ["block:ui/03", { role: "block", ref: "ui/03", raw: "block:ui/03" }],
    ["commit-post-loop", { role: "commit", raw: "commit-post-loop" }],
  ])("parses %s", (label, expected) => {
    expect(parseAgentLabel(label as string)).toEqual(expected);
  });

  test.each(["codex-delegate", "my-custom-label", "", "wat:ui/03#1"])(
    "tolerates unknown label %s",
    (label) => expect(() => parseAgentLabel(label)).not.toThrow(),
  );

  test("returns the raw unknown label", () => {
    expect(parseAgentLabel("codex-delegate")).toEqual({
      role: "unknown",
      raw: "codex-delegate",
    });
  });
});

describe("deriveTaskViews", () => {
  test("applies status precedence and keeps blockedBy off non-blocked rows", () => {
    const views = deriveTaskViews(
      {
        "a/01": task("a/01", "done", ["missing/01"]),
        "a/02": task("a/02", "blocked", ["a/01"]),
        "a/03": task("a/03", "in-progress", ["missing/01"]),
        "a/04": task("a/04", "todo", ["a/01"]),
        "a/05": task("a/05", "todo", ["a/04", "missing/01"]),
      },
      [],
    );
    expect(views.map((view) => view.state)).toEqual([
      "done",
      "blocked",
      "in-progress",
      "ready",
      "blocked",
    ]);
    expect(views[0].blockedBy).toEqual([]);
    expect(views[2].blockedBy).toEqual([]);
    expect(views[3].blockedBy).toEqual([]);
    expect(views[4].blockedBy).toEqual(["a/04", "missing/01"]);
    expect(views[3].dependsOn).toEqual(["a/01"]);
    expect(views[3].blocks).toEqual(["next/01"]);
  });

  test("treats only the open attempt as in progress", () => {
    const entries = [
      note("ui/03", "dev", 1, "2026-01-01T00:00:00Z", "start"),
      note("ui/03", "dev", 1, "2026-01-01T00:01:00Z", "end"),
      note("ui/03", "dev", 2, "2026-01-01T00:02:00Z", "start"),
      score("ui/03", 1, "2026-01-01T00:03:00Z"),
      score("ui/03", 2, "2026-01-01T00:04:00Z"),
    ];
    const [view] = deriveTaskViews({ "ui/03": task("ui/03") }, entries);
    expect(view.state).toBe("in-progress");
    expect(view.attempts).toBe(2);
    expect(view.latestScore?.weighted).toBe(4.7);
  });

  test("keeps a task in progress until every parallel lens has ended", () => {
    const lenses = [
      "simplification",
      "reuse",
      "altitude",
      "codex",
      "efficiency",
    ];
    const entries = [
      ...lenses.map((lens, index) =>
        note(
          "close/01",
          "review",
          1,
          `2026-01-01T00:0${index}:00Z`,
          "start",
          `review:${lens}#1`,
        ),
      ),
      note(
        "close/01",
        "review",
        1,
        "2026-01-01T00:10:00Z",
        "end",
        "review:reuse#1",
      ),
    ];

    const [view] = deriveTaskViews({ "close/01": task("close/01") }, entries);

    expect(view.state).toBe("in-progress");
  });

  test("leaves a task ready once every parallel lens has ended", () => {
    const entries = [
      note(
        "close/01",
        "review",
        1,
        "2026-01-01T00:00:00Z",
        "start",
        "review:reuse#1",
      ),
      note(
        "close/01",
        "review",
        1,
        "2026-01-01T00:01:00Z",
        "start",
        "review:codex#1",
      ),
      note(
        "close/01",
        "review",
        1,
        "2026-01-01T00:02:00Z",
        "end",
        "review:reuse#1",
      ),
      note(
        "close/01",
        "review",
        1,
        "2026-01-01T00:03:00Z",
        "end",
        "review:codex#1",
      ),
    ];

    const [view] = deriveTaskViews({ "close/01": task("close/01") }, entries);

    expect(view.state).toBe("ready");
  });

  test("returns an empty view list for an empty tree", () => {
    expect(deriveTaskViews({}, [])).toEqual([]);
  });
});

describe("aggregateFleet", () => {
  test("pairs by label and computes elapsed time from entry timestamps", () => {
    const rows = aggregateFleet([
      note("ui/03", "dev", 2, "2026-01-01T00:00:00Z", "start", "dev:ui/03#2"),
      note("ui/03", "dev", 2, "2026-01-01T00:00:03Z", "end", "dev:ui/03#2"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "dev:ui/03#2",
      status: "finished",
      elapsedMs: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:03Z",
    });
  });

  test("pairs by fallback identity and leaves unmatched entries incomplete", () => {
    const rows = aggregateFleet([
      note("ui/01", "dev", 1, "2026-01-01T00:00:00Z", "start"),
      note("ui/01", "dev", 1, "2026-01-01T00:00:01Z", "end"),
      note("ui/02", "verify", 1, "2026-01-01T00:00:02Z", "start"),
      note("ui/03", "fix", 1, "2026-01-01T00:00:03Z", "end"),
    ]);
    expect(rows[0]).toMatchObject({
      key: "ui/02|verify|1",
      status: "in-flight",
    });
    expect(rows[0].elapsedMs).toBeUndefined();
    expect(rows[1].startedAt).toBeUndefined();
    expect(rows[1].elapsedMs).toBeUndefined();
    expect(rows[2].key).toBe("ui/01|dev|1");
  });

  test("never closes another task's row when two agents share a label", () => {
    const rows = aggregateFleet([
      note("ui/01", "dev", 1, "2026-01-01T00:00:00Z", "start", "shared"),
      note("ui/02", "dev", 1, "2026-01-01T00:00:01Z", "start", "shared"),
      note("ui/02", "dev", 1, "2026-01-01T00:00:05Z", "end", "shared"),
    ]);

    expect(rows.find((row) => row.ref === "ui/02")).toMatchObject({
      status: "finished",
      elapsedMs: 4000,
    });
    expect(rows.find((row) => row.ref === "ui/01")?.status).toBe("in-flight");
  });

  test("falls back to the triple when only one entry has a label", () => {
    const rows = aggregateFleet([
      note("ui/01", "dev", 1, "2026-01-01T00:00:00Z", "start", "dev:ui/01#1"),
      note("ui/01", "dev", 1, "2026-01-01T00:00:01Z", "end"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "finished", elapsedMs: 1000 });
  });

  test("attaches scores, sorts finished rows, and makes keys unique", () => {
    const entries = [
      note("ui/01", "dev", 1, "2026-01-01T00:00:01Z", undefined, "same"),
      note("ui/02", "dev", 1, "2026-01-01T00:00:03Z", undefined, "same"),
      score("ui/01", 1, "2026-01-01T00:00:02Z"),
    ];
    const rows = aggregateFleet(entries);
    expect(rows.map((row) => row.endedAt)).toEqual([
      "2026-01-01T00:00:03Z",
      "2026-01-01T00:00:02Z",
      "2026-01-01T00:00:01Z",
    ]);
    expect(
      rows.filter((row) => row.label === "same").map((row) => row.key),
    ).toEqual(["same#2", "same"]);
    expect(rows.find((row) => row.ref === "ui/01")?.score?.weighted).toBe(4.6);
  });

  test("attaches a verdict to the judge row without closing or duplicating it", () => {
    const rows = aggregateFleet([
      note(
        "ui/03",
        "judge",
        1,
        "2026-01-01T00:00:00Z",
        "start",
        "judge:ui/03#1",
      ),
      score("ui/03", 1, "2026-01-01T00:00:02Z"),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "judge:ui/03#1",
      status: "in-flight",
    });
    expect(rows[0].score?.weighted).toBe(4.6);
  });

  test("closes the judge row on its end note, not on its verdict", () => {
    const rows = aggregateFleet([
      note(
        "ui/03",
        "judge",
        1,
        "2026-01-01T00:00:00Z",
        "start",
        "judge:ui/03#1",
      ),
      score("ui/03", 1, "2026-01-01T00:00:02Z"),
      note("ui/03", "judge", 1, "2026-01-01T00:00:03Z", "end", "judge:ui/03#1"),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "judge:ui/03#1",
      status: "finished",
      elapsedMs: 3000,
    });
    expect(rows[0].score?.weighted).toBe(4.6);
  });

  test("uses first appearance to break equal timestamp ties", () => {
    const entries = [
      note("ui/01", "dev", 1, "2026-01-01T00:00:00Z"),
      note("ui/02", "dev", 1, "2026-01-01T00:00:00Z"),
    ];
    expect(aggregateFleet(entries).map((row) => row.ref)).toEqual([
      "ui/01",
      "ui/02",
    ]);
    expect(aggregateFleet(entries).map((row) => row.ref)).toEqual([
      "ui/01",
      "ui/02",
    ]);
  });

  test("handles empty and semantically odd logs without throwing", () => {
    expect(aggregateFleet([])).toEqual([]);
    expect(() =>
      aggregateFleet([
        {
          kind: "note",
          ts: "bad",
          task: "outside/01",
          message: "odd",
        } as FlightlogEntry,
      ]),
    ).not.toThrow();
  });
});
