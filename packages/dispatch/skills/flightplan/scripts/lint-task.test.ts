import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintFile, collectTaskFiles, inferRefFromPath } from "./lint-task";

const VALID_TASK = `# UI-01: Fixture state shell

> **Required reading**:
> - \`../_context/shared.md\`
>
> **Depends on**: none
> **Status**: todo

## Goal
One sentence.

## Files to create / modify
- a.ts (new)

## Acceptance criteria
- [ ] One

## Verification
- [ ] Run \`bun test\`

## Eval rubric

> 各項 0–5,加權平均 > 4.0 通過;正確性 < 4 一票否決。

| 維度 | 權重 | 4–5(過關) |
|---|---|---|
| 正確性 | ×3 | 算對 |
| 測試涵蓋 | ×1 | 含邊界 |
`;

async function writeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flightplan-lint-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  return root;
}

describe("lintFile", () => {
  test("valid task → no violations", async () => {
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": VALID_TASK,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations).toEqual([]);
    await rm(root, { recursive: true });
  });

  test("missing Required reading paths → violation", async () => {
    const root = await writeTree({
      "tasks/ui/01-foo.md": VALID_TASK, // shared.md not created
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "required-reading")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("Required reading outside _context/ → violation", async () => {
    const bad = VALID_TASK.replace(
      "`../_context/shared.md`",
      "`../../docs/PLAN.md`",
    );
    const root = await writeTree({ "tasks/ui/01-foo.md": bad });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "required-reading")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("Required reading must be sibling ../_context — absolute path rejected", async () => {
    const bad = VALID_TASK.replace(
      "`../_context/shared.md`",
      "`/Users/foo/tasks/_context/shared.md`",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some(
        (v) =>
          v.rule === "required-reading" && /sibling _context/.test(v.detail),
      ),
    ).toBe(true);
    await rm(root, { recursive: true });
  });

  test("Required reading must be sibling — deep traversal rejected", async () => {
    const bad = VALID_TASK.replace(
      "`../_context/shared.md`",
      "`../../something/_context/shared.md`",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some(
        (v) =>
          v.rule === "required-reading" && /sibling _context/.test(v.detail),
      ),
    ).toBe(true);
    await rm(root, { recursive: true });
  });

  test("body mentions PLAN.md → violation", async () => {
    const bad = VALID_TASK.replace("One sentence.", "See PLAN.md for context.");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "self-containment")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("body mentions plan.md (lowercase) → violation", async () => {
    const bad = VALID_TASK.replace("One sentence.", "See plan.md for context.");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "self-containment")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("body references sibling task file (with .md) → violation", async () => {
    const bad = VALID_TASK.replace(
      "One sentence.",
      "Follow the pattern from ui/02-bar.md.",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "self-containment")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("body references sibling shorthand bucket/NN → violation", async () => {
    const bad = VALID_TASK.replace(
      "One sentence.",
      "After ui/02 is done, this can ship.",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "self-containment")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("body referencing its OWN file path → no violation", async () => {
    const ok = VALID_TASK.replace(
      "One sentence.",
      "This task lives at ui/01-foo.md.",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": ok,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.filter((v) => v.rule === "self-containment")).toEqual([]);
    await rm(root, { recursive: true });
  });

  test("H1 bucket/NN mismatches file path → violation", async () => {
    // File path says ui/01 but H1 claims API-99
    const bad = VALID_TASK.replace(
      "# UI-01: Fixture state shell",
      "# API-99: Bogus claim",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "h1-path-mismatch")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("missing Acceptance criteria section → violation", async () => {
    const bad = VALID_TASK.replace(
      /## Acceptance criteria\n- \[ \] One\n\n/,
      "",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "sections")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("Acceptance criteria with no checkbox → violation", async () => {
    const bad = VALID_TASK.replace("- [ ] One", "Just prose, no checkbox.");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some(
        (v) => v.rule === "sections" && /checkbox/.test(v.detail),
      ),
    ).toBe(true);
    await rm(root, { recursive: true });
  });

  test("missing Verification section → violation", async () => {
    const bad = VALID_TASK.replace(/## Verification[\s\S]*$/, "");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some(
        (v) => v.rule === "sections" && /Verification/.test(v.detail),
      ),
    ).toBe(true);
    await rm(root, { recursive: true });
  });

  test("bad status value → violation", async () => {
    const bad = VALID_TASK.replace("**Status**: todo", "**Status**: pending");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "status")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("status with trailing junk → violation", async () => {
    const bad = VALID_TASK.replace(
      "**Status**: todo",
      "**Status**: todo maybe",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "status")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("malformed file → parse violation", async () => {
    const root = await writeTree({
      "tasks/ui/01-foo.md": "no h1, no quote, just text",
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "parse")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("valid task carries no rubric violation", async () => {
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": VALID_TASK,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "rubric")).toBe(false);
    await rm(root, { recursive: true });
  });

  test("missing Eval rubric section → violation", async () => {
    const bad = VALID_TASK.slice(0, VALID_TASK.indexOf("## Eval rubric"));
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some((v) => v.rule === "rubric" && /missing/.test(v.detail)),
    ).toBe(true);
    await rm(root, { recursive: true });
  });

  test("Eval rubric present but unparseable → violation", async () => {
    const bad = VALID_TASK.replace(
      "> 各項 0–5,加權平均 > 4.0 通過;正確性 < 4 一票否決。",
      "> 看著辦,差不多就好。",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some(
        (v) => v.rule === "rubric" && /unparseable/.test(v.detail),
      ),
    ).toBe(true);
    await rm(root, { recursive: true });
  });

  test("pass threshold out of scale → violation", async () => {
    const bad = VALID_TASK.replace("加權平均 > 4.0 通過", "加權平均 > 9 通過");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some((v) => v.rule === "rubric" && /scale/.test(v.detail)),
    ).toBe(true);
    await rm(root, { recursive: true });
  });
});

describe("collectTaskFiles", () => {
  test("skips _context/ and README.md", async () => {
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/README.md": "# Index\n",
      "tasks/ui/01-foo.md": VALID_TASK,
      "tasks/ui/02-bar.md": VALID_TASK,
      "tasks/backend/01-baz.md": VALID_TASK,
    });
    const files = await collectTaskFiles(join(root, "tasks"));
    expect(files).toHaveLength(3);
    expect(files.every((f) => !f.includes("_context"))).toBe(true);
    expect(files.every((f) => !f.endsWith("README.md"))).toBe(true);
    await rm(root, { recursive: true });
  });

  test("ignores non-md files inside bucket dirs", async () => {
    const root = await writeTree({
      "tasks/ui/01-foo.md": VALID_TASK,
      "tasks/ui/.gitkeep": "",
      "tasks/ui/notes.txt": "scratch",
    });
    const files = await collectTaskFiles(join(root, "tasks"));
    expect(files).toHaveLength(1);
    await rm(root, { recursive: true });
  });
});

describe("inferRefFromPath", () => {
  test("extracts bucket and NN from canonical path", () => {
    expect(inferRefFromPath("/abs/docs/x/tasks/ui/01-foo.md")).toEqual({
      bucket: "ui",
      nn: "01",
    });
  });

  test("returns null when filename lacks NN- prefix", () => {
    expect(inferRefFromPath("/abs/tasks/ui/foo.md")).toBeNull();
  });

  test("returns null when bucket name has dashes", () => {
    expect(inferRefFromPath("/abs/tasks/my-bucket/01-foo.md")).toBeNull();
  });
});
