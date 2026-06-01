import { describe, expect, test } from "bun:test";
import { scoreTask } from "./score-task";
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
