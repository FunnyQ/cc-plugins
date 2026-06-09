import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildReviewPrompt, collectPlanFiles } from "./review-plan";

async function newRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "flightplan-review-"));
}

describe("collectPlanFiles", () => {
  test("finds PLAN.md", async () => {
    const root = await newRoot();
    await writeFile(join(root, "PLAN.md"), "# Plan\n");

    const result = await collectPlanFiles(root);
    expect(result).toEqual([join(root, "PLAN.md")]);

    await rm(root, { recursive: true });
  });

  test("_context files are collected in order", async () => {
    const root = await newRoot();
    await mkdir(join(root, "tasks/_context"), { recursive: true });
    await writeFile(join(root, "tasks/_context/zeta.md"), "# Zeta\n");
    await writeFile(join(root, "tasks/_context/alpha.md"), "# Alpha\n");

    const result = await collectPlanFiles(root);
    expect(result).toEqual([
      join(root, "tasks/_context/alpha.md"),
      join(root, "tasks/_context/zeta.md"),
    ]);

    await rm(root, { recursive: true });
  });

  test("task files across buckets are collected and README.md is excluded", async () => {
    const root = await newRoot();
    await mkdir(join(root, "tasks/backend"), { recursive: true });
    await mkdir(join(root, "tasks/ui"), { recursive: true });
    await writeFile(join(root, "tasks/ui/02-polish.md"), "# Polish\n");
    await writeFile(join(root, "tasks/ui/README.md"), "# Read me\n");
    await writeFile(join(root, "tasks/backend/01-api.md"), "# API\n");
    await writeFile(join(root, "tasks/backend/README.md"), "# Read me\n");

    const result = await collectPlanFiles(root);
    expect(result).toEqual([
      join(root, "tasks/backend/01-api.md"),
      join(root, "tasks/ui/02-polish.md"),
    ]);

    await rm(root, { recursive: true });
  });

  test("missing dirs are gracefully skipped", async () => {
    const root = await newRoot();
    await writeFile(join(root, "PLAN.md"), "# Plan\n");

    const result = await collectPlanFiles(root);
    expect(result).toEqual([join(root, "PLAN.md")]);

    await rm(root, { recursive: true });
  });

  test("returns empty array when planDir is empty", async () => {
    const root = await newRoot();

    const result = await collectPlanFiles(root);
    expect(result).toEqual([]);

    await rm(root, { recursive: true });
  });
});

describe("buildReviewPrompt", () => {
  test("output starts with review instructions", async () => {
    const root = await newRoot();
    const file = join(root, "PLAN.md");
    await writeFile(file, "# Plan\n");

    const result = await buildReviewPrompt([file]);
    expect(result.startsWith("You are reviewing a flightplan artifact")).toBe(
      true,
    );

    await rm(root, { recursive: true });
  });

  test("each file appears as a header with relative path", async () => {
    const root = await newRoot();
    const plan = join(root, "PLAN.md");
    const task = join(root, "tasks/ui/01-build.md");
    await mkdir(join(root, "tasks/ui"), { recursive: true });
    await writeFile(plan, "# Plan\n");
    await writeFile(task, "# Build\n");

    const result = await buildReviewPrompt([plan, task]);
    expect(result).toContain(`## ${relative(process.cwd(), plan)}`);
    expect(result).toContain(`## ${relative(process.cwd(), task)}`);

    await rm(root, { recursive: true });
  });

  test("file contents are embedded in markdown code fences", async () => {
    const root = await newRoot();
    const file = join(root, "PLAN.md");
    await writeFile(file, "# Plan\n\nAcceptance criteria\n");

    const result = await buildReviewPrompt([file]);
    expect(result).toContain(
      `## ${relative(process.cwd(), file)}\n\`\`\`markdown\n# Plan\n\nAcceptance criteria\n\n\`\`\``,
    );

    await rm(root, { recursive: true });
  });

  test("files appear in input order", async () => {
    const root = await newRoot();
    const second = join(root, "second.md");
    const first = join(root, "first.md");
    await writeFile(second, "# Second\n");
    await writeFile(first, "# First\n");

    const result = await buildReviewPrompt([second, first]);
    const secondIndex = result.indexOf(`## ${relative(process.cwd(), second)}`);
    const firstIndex = result.indexOf(`## ${relative(process.cwd(), first)}`);
    expect(secondIndex).toBeGreaterThan(-1);
    expect(firstIndex).toBeGreaterThan(secondIndex);

    await rm(root, { recursive: true });
  });
});
