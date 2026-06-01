import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreTask, buildScoreEntry, type ScoreResult } from "./score-task";
import { parseLog } from "./lib/flightlog";
import type { Rubric } from "./lib/parse-task";

// Mirrors the urban-renewal rubric: 0–5, pass > 4.0, 正確性 < 4 vetoes.
const RUBRIC: Rubric = {
  passThreshold: 4.0,
  passOp: ">",
  scaleMax: 5,
  hardFail: { dimension: "正確性", op: "<", value: 4 },
  dimensions: [
    { name: "正確性", weight: 3 },
    { name: "測試涵蓋", weight: 2 },
    { name: "介面與可讀性", weight: 1 },
    { name: "假設與文件", weight: 1 },
  ],
};

describe("scoreTask", () => {
  test("all 5s → passes", () => {
    const r = scoreTask(RUBRIC, {
      正確性: 5,
      測試涵蓋: 5,
      介面與可讀性: 5,
      假設與文件: 5,
    });
    expect(r.weighted).toBe(5);
    expect(r.passed).toBe(true);
    expect(r.hardFailed).toBe(false);
  });

  test("weighted average uses the weights", () => {
    // (4×3 + 5×2 + 4×1 + 4×1) / 7 = 30/7 ≈ 4.2857
    const r = scoreTask(RUBRIC, {
      正確性: 4,
      測試涵蓋: 5,
      介面與可讀性: 4,
      假設與文件: 4,
    });
    expect(r.weighted).toBeCloseTo(30 / 7, 5);
    expect(r.passed).toBe(true);
  });

  test("hard-fail veto: 正確性 < 4 fails despite a high average", () => {
    // (3×3 + 5×2 + 5×1 + 5×1) / 7 = 29/7 ≈ 4.14 — above 4.0, but vetoed.
    const r = scoreTask(RUBRIC, {
      正確性: 3,
      測試涵蓋: 5,
      介面與可讀性: 5,
      假設與文件: 5,
    });
    expect(r.weighted).toBeCloseTo(29 / 7, 5);
    expect(r.hardFailed).toBe(true);
    expect(r.passed).toBe(false);
  });

  test("pass line is strict ('>'): exactly on the line fails", () => {
    const r = scoreTask(RUBRIC, {
      正確性: 4,
      測試涵蓋: 4,
      介面與可讀性: 4,
      假設與文件: 4,
    });
    expect(r.weighted).toBe(4);
    expect(r.passed).toBe(false);
  });

  test(">= operator passes when exactly on the line", () => {
    const r = scoreTask(
      { ...RUBRIC, passOp: ">=" },
      { 正確性: 4, 測試涵蓋: 4, 介面與可讀性: 4, 假設與文件: 4 },
    );
    expect(r.passed).toBe(true);
  });

  test("missing a dimension → cannot pass, reported", () => {
    const r = scoreTask(RUBRIC, { 正確性: 5, 測試涵蓋: 5, 介面與可讀性: 5 });
    expect(r.missing).toEqual(["假設與文件"]);
    expect(r.passed).toBe(false);
  });

  test("breakdown reports per-dimension contributions", () => {
    const r = scoreTask(RUBRIC, {
      正確性: 5,
      測試涵蓋: 4,
      介面與可讀性: 3,
      假設與文件: 2,
    });
    expect(r.breakdown).toContainEqual({
      name: "正確性",
      weight: 3,
      score: 5,
      contribution: 15,
    });
  });
});

describe("buildScoreEntry", () => {
  test("maps a verdict + metadata to a flightlog score entry", () => {
    const result: ScoreResult = scoreTask(RUBRIC, {
      正確性: 5,
      測試涵蓋: 4,
      介面與可讀性: 4,
      假設與文件: 4,
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
    expect(entry.breakdown[0]).toEqual({ name: "正確性", weight: 3, score: 5 });
  });

  test("defaults attempt to 1 when unspecified", () => {
    const result = scoreTask(RUBRIC, {
      正確性: 5,
      測試涵蓋: 5,
      介面與可讀性: 5,
      假設與文件: 5,
    });
    const entry = buildScoreEntry(result, {
      task: "ui/03",
      ts: "2026-06-01T10:00:00.000Z",
    });
    expect(entry.attempt).toBe(1);
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

> 各項 0–5,加權平均 > 4.0 通過;正確性 < 4 一票否決。

| 維度 | 權重 | 0–1 | 2–3 | 4–5 |
|---|---|---|---|---|
| 正確性 | ×3 | a | b | c |
| 測試涵蓋 | ×2 | a | b | c |
| 介面與可讀性 | ×1 | a | b | c |
| 假設與文件 | ×1 | a | b | c |
`;

describe("score-task CLI --log", () => {
  test("appends a verdict to the flightlog trail and exits with the gate code", async () => {
    const root = await mkdtemp(join(tmpdir(), "score-task-cli-"));
    const taskFile = join(root, "03-sample.md");
    const scoresFile = join(root, "scores.json");
    const logFile = join(root, ".flightlog", "run.jsonl");
    await writeFile(taskFile, SAMPLE_TASK);
    await writeFile(
      scoresFile,
      JSON.stringify({
        正確性: 5,
        測試涵蓋: 4,
        介面與可讀性: 4,
        假設與文件: 4,
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
});
