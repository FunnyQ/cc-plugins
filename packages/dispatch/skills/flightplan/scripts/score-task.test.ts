import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scoreTask,
  buildScoreEntry,
  toJsonResult,
  type ScoreResult,
} from "./score-task";
import { parseLog } from "./lib/flightlog";
import type { Rubric } from "./lib/parse-task";

// Mirrors a typical rubric: 0–5, pass > 4.0, Correctness < 4 vetoes.
const RUBRIC: Rubric = {
  passThreshold: 4.0,
  passOp: ">",
  scaleMax: 5,
  hardFail: { dimension: "Correctness", op: "<", value: 4 },
  dimensions: [
    { name: "Correctness", weight: 3 },
    { name: "Test coverage", weight: 2 },
    { name: "Interface & readability", weight: 1 },
    { name: "Assumptions & docs", weight: 1 },
  ],
};

describe("scoreTask", () => {
  test("all 5s → passes", () => {
    const r = scoreTask(RUBRIC, {
      Correctness: 5,
      "Test coverage": 5,
      "Interface & readability": 5,
      "Assumptions & docs": 5,
    });
    expect(r.weighted).toBe(5);
    expect(r.passed).toBe(true);
    expect(r.hardFailed).toBe(false);
  });

  test("weighted average uses the weights", () => {
    // (4×3 + 5×2 + 4×1 + 4×1) / 7 = 30/7 ≈ 4.2857
    const r = scoreTask(RUBRIC, {
      Correctness: 4,
      "Test coverage": 5,
      "Interface & readability": 4,
      "Assumptions & docs": 4,
    });
    expect(r.weighted).toBeCloseTo(30 / 7, 5);
    expect(r.passed).toBe(true);
  });

  test("hard-fail veto: Correctness < 4 fails despite a high average", () => {
    // (3×3 + 5×2 + 5×1 + 5×1) / 7 = 29/7 ≈ 4.14 — above 4.0, but vetoed.
    const r = scoreTask(RUBRIC, {
      Correctness: 3,
      "Test coverage": 5,
      "Interface & readability": 5,
      "Assumptions & docs": 5,
    });
    expect(r.weighted).toBeCloseTo(29 / 7, 5);
    expect(r.hardFailed).toBe(true);
    expect(r.passed).toBe(false);
  });

  test("pass line is strict ('>'): exactly on the line fails", () => {
    const r = scoreTask(RUBRIC, {
      Correctness: 4,
      "Test coverage": 4,
      "Interface & readability": 4,
      "Assumptions & docs": 4,
    });
    expect(r.weighted).toBe(4);
    expect(r.passed).toBe(false);
  });

  test(">= operator passes when exactly on the line", () => {
    const r = scoreTask(
      { ...RUBRIC, passOp: ">=" },
      {
        Correctness: 4,
        "Test coverage": 4,
        "Interface & readability": 4,
        "Assumptions & docs": 4,
      },
    );
    expect(r.passed).toBe(true);
  });

  test("missing a dimension → cannot pass, reported", () => {
    const r = scoreTask(RUBRIC, {
      Correctness: 5,
      "Test coverage": 5,
      "Interface & readability": 5,
    });
    expect(r.missing).toEqual(["Assumptions & docs"]);
    expect(r.passed).toBe(false);
  });

  test("breakdown reports per-dimension contributions", () => {
    const r = scoreTask(RUBRIC, {
      Correctness: 5,
      "Test coverage": 4,
      "Interface & readability": 3,
      "Assumptions & docs": 2,
    });
    expect(r.breakdown).toContainEqual({
      name: "Correctness",
      weight: 3,
      score: 5,
      contribution: 15,
    });
  });
});

describe("buildScoreEntry", () => {
  test("maps a verdict + metadata to a flightlog score entry", () => {
    const result: ScoreResult = scoreTask(RUBRIC, {
      Correctness: 5,
      "Test coverage": 4,
      "Interface & readability": 4,
      "Assumptions & docs": 4,
    });
    const entry = buildScoreEntry(result, {
      task: "ui/03",
      ts: "2026-06-01T10:00:00.000Z",
      attempt: 2,
      agentLabel: "judge-ui-03-a2",
    });
    expect(entry.kind).toBe("score");
    expect(entry.task).toBe("ui/03");
    expect(entry.attempt).toBe(2);
    expect(entry.passed).toBe(result.passed);
    // breakdown is trimmed to name/weight/score (no contribution noise)
    expect(entry.breakdown[0]).toEqual({
      name: "Correctness",
      weight: 3,
      score: 5,
    });
  });

  test("defaults attempt to 1 when unspecified", () => {
    const result = scoreTask(RUBRIC, {
      Correctness: 5,
      "Test coverage": 5,
      "Interface & readability": 5,
      "Assumptions & docs": 5,
    });
    const entry = buildScoreEntry(result, {
      task: "ui/03",
      ts: "2026-06-01T10:00:00.000Z",
    });
    expect(entry.attempt).toBe(1);
  });
});

describe("toJsonResult", () => {
  test("keeps only the machine gate fields", () => {
    const result = scoreTask(RUBRIC, {
      Correctness: 3,
      "Test coverage": 5,
    });
    expect(toJsonResult(result)).toEqual({
      weighted: result.weighted,
      passed: false,
      hardFailed: true,
      missing: ["Interface & readability", "Assumptions & docs"],
    });
  });
});

const SAMPLE_TASK = `# UI-03: Sample task

> **Required reading**:
> - \`../_context/shared.md\`
>
> **Depends on**: none — foundation task
> **Status**: todo

## Goal

Do the thing.

## Eval rubric

> Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| Correctness | ×3 | a | b | c |
| Test coverage | ×2 | a | b | c |
| Interface & readability | ×1 | a | b | c |
| Assumptions & docs | ×1 | a | b | c |
`;

describe("score-task CLI", () => {
  test("--log appends a verdict to the flightlog trail and exits with the gate code", async () => {
    const root = await mkdtemp(join(tmpdir(), "score-task-cli-"));
    const taskFile = join(root, "03-sample.md");
    const scoresFile = join(root, "scores.json");
    const logFile = join(root, ".flightlog", "run.jsonl");
    await writeFile(taskFile, SAMPLE_TASK);
    await writeFile(
      scoresFile,
      JSON.stringify({
        Correctness: 5,
        "Test coverage": 4,
        "Interface & readability": 4,
        "Assumptions & docs": 4,
      }),
    );

    const proc = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "score-task.ts"),
        taskFile,
        scoresFile,
        "--log",
        logFile,
        "--attempt",
        "2",
        "--agent",
        "judge-ui-03-a2",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    expect(code).toBe(0); // 30/7 ≈ 4.29 > 4.0 → pass

    const entries = parseLog(await readFile(logFile, "utf-8"));
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.kind).toBe("score");
    expect(entry.task).toBe("ui/03");
    if (entry.kind === "score") {
      expect(entry.attempt).toBe(2);
      expect(entry.agentLabel).toBe("judge-ui-03-a2");
      expect(entry.passed).toBe(true);
    }

    await rm(root, { recursive: true });
  });

  test("--json prints the compact verdict and still composes with --log", async () => {
    const root = await mkdtemp(join(tmpdir(), "score-task-json-"));
    const taskFile = join(root, "03-sample.md");
    const scoresFile = join(root, "scores.json");
    const logFile = join(root, ".flightlog", "run.jsonl");
    await writeFile(taskFile, SAMPLE_TASK);
    await writeFile(
      scoresFile,
      JSON.stringify({
        Correctness: 5,
        "Test coverage": 4,
        "Interface & readability": 4,
        "Assumptions & docs": 4,
      }),
    );

    const proc = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "score-task.ts"),
        taskFile,
        scoresFile,
        "--json",
        "--log",
        logFile,
        "--attempt",
        "2",
        "--agent",
        "judge-ui-03-a2",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      weighted: 31 / 7,
      passed: true,
      hardFailed: false,
      missing: [],
    });

    const entries = parseLog(await readFile(logFile, "utf-8"));
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("score");

    await rm(root, { recursive: true });
  });
});
