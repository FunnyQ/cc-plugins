import { describe, expect, test } from "bun:test";
import { parseTask, parseRubric, refToString } from "./parse-task";

// Mirrors a real-world engine task rubric — the format flightplan rubrics
// must stay compatible with.
const REAL_RUBRIC = `## Eval rubric

> Scale and shared dimensions: see \`../_context/rubric.md\`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | base volume can't compute 5,264 | base matches but coverage 611 drifts too far | base fully matches |
| Test coverage | ×2 | no tests | only the base volume tested | covers coverage ratio + boundary values |
| Interface & readability | ×1 | not pure or smuggles I/O | usable but naming/types unclear | pure function, clear types |
| Assumptions & docs | ×1 | exemption default is an unmarked magic number | default present, not explained | default flagged TODO for review |
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
  test("parses the real-world rubric format", () => {
    const rubric = parseRubric(REAL_RUBRIC);
    expect(rubric).not.toBeNull();
    if (!rubric) return;
    expect(rubric.passThreshold).toBe(4.0);
    expect(rubric.passOp).toBe(">");
    expect(rubric.scaleMax).toBe(5);
    expect(rubric.hardFail).toEqual({
      dimension: "Correctness",
      op: "<",
      value: 4,
    });
    expect(rubric.dimensions).toEqual([
      { name: "Correctness", weight: 3 },
      { name: "Test coverage", weight: 2 },
      { name: "Interface & readability", weight: 1 },
      { name: "Assumptions & docs", weight: 1 },
    ]);
  });

  test("accepts ≥ and >= as the pass operator", () => {
    const a = parseRubric(REAL_RUBRIC.replace("> 4.0 to pass", "≥ 4 to pass"));
    expect(a?.passOp).toBe(">=");
    expect(a?.passThreshold).toBe(4);
    const b = parseRubric(REAL_RUBRIC.replace("> 4.0 to pass", ">= 4 to pass"));
    expect(b?.passOp).toBe(">=");
  });

  test("veto dimension name is read verbatim from the threshold line", () => {
    const src = REAL_RUBRIC.replace(
      "Correctness < 4 is an automatic veto",
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
    const src = REAL_RUBRIC.replace(
      "; Correctness < 4 is an automatic veto",
      "",
    );
    const rubric = parseRubric(src);
    expect(rubric).not.toBeNull();
    expect(rubric?.hardFail).toBeNull();
  });

  test("returns null when there is no Eval rubric section", () => {
    expect(parseRubric("## Goal\nsome text\n")).toBeNull();
  });

  test("returns null when the pass-threshold line is missing", () => {
    const src = REAL_RUBRIC.replace(
      "> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.",
      "> Scale: see `../_context/rubric.md`.",
    );
    expect(parseRubric(src)).toBeNull();
  });

  test("returns null when the dimension table has no weighted rows", () => {
    const src = `## Eval rubric

> weighted average > 4.0 to pass.

prose only, no table.
`;
    expect(parseRubric(src)).toBeNull();
  });

  test("ignores the separator row and unweighted rows", () => {
    const src = `## Eval rubric

> Each dimension 0–5; weighted average > 4.0 to pass.

| Dimension | Weight | Notes |
|---|---|---|
| Correctness | ×2 | a |
| Notes | — | not a weighted dimension |
`;
    const rubric = parseRubric(src);
    expect(rubric?.dimensions).toEqual([{ name: "Correctness", weight: 2 }]);
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
