import { describe, expect, test } from "bun:test";
import { parseTask, parseRubric, refToString } from "./parse-task";

// Lifted verbatim from urban-renewal-proposer engine/03-base-volume-engine.md —
// the real-world format flightplan rubrics must stay compatible with.
const REAL_RUBRIC = `## Eval rubric

> 尺度與通用維度見 \`../_context/rubric.md\`。各項 0–5,加權平均 > 4.0 通過;正確性 < 4 一票否決。

| 維度 | 權重 | 0–1(不及格) | 2–3(未達標) | 4–5(過關) |
|---|---|---|---|---|
| 正確性 | ×3 | 基準容積對錦新算不出 5,264 | 基準對但建蔽 611 偏差過大 | 基準完全吻合 |
| 測試涵蓋 | ×2 | 無測試 | 只測基準容積 | 含建蔽、邊界值 |
| 介面與可讀性 | ×1 | 非純函式或夾帶 I/O | 堪用但命名/型別不清 | 純函式、型別清楚 |
| 假設與文件 | ×1 | 免計預設是無註記魔術數字 | 有預設無說明 | 預設標 TODO 待校正 |
`;

const VALID = `# UI-01: Fixture state shell

> **Required reading**:
> - \`../_context/shared.md\`
> - \`../_context/api-contract.md\`
>
> **Depends on**: ui/02, backend/01
> **Blocks**: ui/05
> **Status**: todo

## Goal
One sentence.

## Files to create / modify
- a.ts (new)

## Acceptance criteria
- [ ] One
- [ ] Two

## Verification
- [ ] Run \`bun test\`
`;

describe("parseTask", () => {
  test("parses a well-formed task file", () => {
    const result = parseTask(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = result.task;

    expect(t.bucket).toBe("ui");
    expect(t.nn).toBe("01");
    expect(t.title).toBe("Fixture state shell");
    expect(t.requiredReading).toEqual([
      "../_context/shared.md",
      "../_context/api-contract.md",
    ]);
    expect(t.dependsOn).toEqual([
      { bucket: "ui", nn: "02" },
      { bucket: "backend", nn: "01" },
    ]);
    expect(t.blocks).toEqual([{ bucket: "ui", nn: "05" }]);
    expect(t.status).toBe("todo");
    expect(t.sections).toEqual([
      "Goal",
      "Files to create / modify",
      "Acceptance criteria",
      "Verification",
    ]);
  });

  test("treats `none` as empty deps", () => {
    const src = VALID.replace(
      "**Depends on**: ui/02, backend/01",
      "**Depends on**: none — foundation task",
    );
    const result = parseTask(src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.dependsOn).toEqual([]);
  });

  test("rejects missing H1", () => {
    const result = parseTask("no h1 here\n> **Status**: todo");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/H1|missing/i);
  });

  test("rejects malformed H1", () => {
    const result = parseTask("# this is wrong shape\n");
    expect(result.ok).toBe(false);
  });

  test("rejects missing header blockquote", () => {
    const result = parseTask("# UI-01: Title\n\nbody\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/blockquote/i);
  });

  test("returns null status when value is not a known value", () => {
    const src = VALID.replace("**Status**: todo", "**Status**: maybe");
    const result = parseTask(src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBeNull();
  });

  test("rejects status with trailing words", () => {
    const src = VALID.replace("**Status**: todo", "**Status**: todo maybe");
    const result = parseTask(src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBeNull();
  });

  test("rejects status with trailing pipe options", () => {
    const src = VALID.replace(
      "**Status**: todo",
      "**Status**: todo | in-progress | done",
    );
    const result = parseTask(src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBeNull();
  });

  test("finalReview defaults to false", () => {
    const result = parseTask(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.finalReview).toBe(false);
  });

  test("parses `Final review: true` from the header", () => {
    const src = VALID.replace(
      "> **Status**: todo",
      "> **Status**: todo\n> **Final review**: true",
    );
    const result = parseTask(src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.finalReview).toBe(true);
  });

  test("Blocks omitted is ok", () => {
    const src = VALID.replace("> **Blocks**: ui/05\n", "");
    const result = parseTask(src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.blocks).toEqual([]);
  });
});

describe("parseRubric", () => {
  test("parses the real urban-renewal rubric format", () => {
    const rubric = parseRubric(REAL_RUBRIC);
    expect(rubric).not.toBeNull();
    if (!rubric) return;
    expect(rubric.passThreshold).toBe(4.0);
    expect(rubric.passOp).toBe(">");
    expect(rubric.scaleMax).toBe(5);
    expect(rubric.hardFail).toEqual({
      dimension: "正確性",
      op: "<",
      value: 4,
    });
    expect(rubric.dimensions).toEqual([
      { name: "正確性", weight: 3 },
      { name: "測試涵蓋", weight: 2 },
      { name: "介面與可讀性", weight: 1 },
      { name: "假設與文件", weight: 1 },
    ]);
  });

  test("accepts ≥ and >= as the pass operator", () => {
    const a = parseRubric(REAL_RUBRIC.replace("> 4.0 通過", "≥ 4 通過"));
    expect(a?.passOp).toBe(">=");
    expect(a?.passThreshold).toBe(4);
    const b = parseRubric(REAL_RUBRIC.replace("> 4.0 通過", ">= 4 通過"));
    expect(b?.passOp).toBe(">=");
  });

  test("language-neutral: English dimension veto", () => {
    const src = REAL_RUBRIC.replace(
      "正確性 < 4 一票否決",
      "correctness < 4 veto",
    );
    const rubric = parseRubric(src);
    expect(rubric?.hardFail).toEqual({
      dimension: "correctness",
      op: "<",
      value: 4,
    });
  });

  test("hard fail is optional", () => {
    const src = REAL_RUBRIC.replace(";正確性 < 4 一票否決", "");
    const rubric = parseRubric(src);
    expect(rubric).not.toBeNull();
    expect(rubric?.hardFail).toBeNull();
  });

  test("returns null when there is no Eval rubric section", () => {
    expect(parseRubric("## Goal\nsome text\n")).toBeNull();
  });

  test("returns null when the pass-threshold line is missing", () => {
    const src = REAL_RUBRIC.replace(
      "> 尺度與通用維度見 `../_context/rubric.md`。各項 0–5,加權平均 > 4.0 通過;正確性 < 4 一票否決。",
      "> 尺度見 `../_context/rubric.md`。",
    );
    expect(parseRubric(src)).toBeNull();
  });

  test("returns null when the dimension table has no weighted rows", () => {
    const src = `## Eval rubric

> 加權平均 > 4.0 通過。

prose only, no table.
`;
    expect(parseRubric(src)).toBeNull();
  });

  test("ignores the separator row and unweighted rows", () => {
    const src = `## Eval rubric

> 各項 0–5,加權平均 > 4.0 通過。

| 維度 | 權重 | 說明 |
|---|---|---|
| 正確性 | ×2 | a |
| 備註 | — | not a weighted dimension |
`;
    const rubric = parseRubric(src);
    expect(rubric?.dimensions).toEqual([{ name: "正確性", weight: 2 }]);
  });
});

describe("parseTask + rubric", () => {
  test("attaches a parsed rubric to the task", () => {
    const src = `${VALID}\n${REAL_RUBRIC}`;
    const result = parseTask(src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.sections).toContain("Eval rubric");
    expect(result.task.rubric?.dimensions.length).toBe(4);
    expect(result.task.rubric?.passThreshold).toBe(4.0);
  });

  test("rubric is null when absent", () => {
    const result = parseTask(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.rubric).toBeNull();
  });
});

describe("refToString", () => {
  test("formats bucket/NN", () => {
    expect(refToString({ bucket: "ui", nn: "01" })).toBe("ui/01");
  });
});
