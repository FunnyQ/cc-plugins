import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

const HOOK = join(import.meta.dir, "flightplan-lint.sh");
const PLUGIN_ROOT = join(import.meta.dir, "..");

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

> Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 4–5 (pass) |
|---|---|---|
| Correctness | ×3 | correct |
| Test coverage | ×1 | covers edges |
`;

const ANNOTATED_HEADER =
  "> **Required reading** (read before starting; do not need to open other files):";

const ANNOTATED_TASK = VALID_TASK.replace(
  "> **Required reading**:",
  ANNOTATED_HEADER,
);

type HookRun = {
  code: number;
  stderr: string;
  stdout: string;
};

async function runHook(stdin: string): Promise<HookRun> {
  const proc = Bun.spawn(["bash", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  });
  proc.stdin.write(stdin);
  await proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stderr, stdout };
}

function payload(filePath: string): string {
  return JSON.stringify({ tool_input: { file_path: filePath } });
}

async function makeTaskTree(taskBody: string): Promise<{
  root: string;
  taskFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "flightplan-hook-"));
  await mkdir(join(root, "docs/sample/tasks/_context"), { recursive: true });
  await writeFile(
    join(root, "docs/sample/tasks/_context/shared.md"),
    "# Shared\n",
  );
  await mkdir(join(root, "docs/sample/tasks/ui"), { recursive: true });
  const taskFile = join(root, "docs/sample/tasks/ui/01-foo.md");
  await writeFile(taskFile, taskBody);
  return { root, taskFile };
}

test("ANNOTATED_HEADER is the header the task template scaffolds", async () => {
  const template = await readFile(
    join(PLUGIN_ROOT, "skills/flightplan/references/task-template.md"),
    "utf8",
  );
  expect(template).toContain(`\n${ANNOTATED_HEADER}\n`);
});

describe("flightplan-lint hook", () => {
  test("non-task path → silent exit 0", async () => {
    const { code, stderr, stdout } = await runHook(payload("/tmp/random.md"));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("");
  });

  test("empty file_path → exit 0", async () => {
    const { code, stderr } = await runHook(JSON.stringify({ tool_input: {} }));
    expect(code).toBe(0);
    expect(stderr).toBe("");
  });

  test("malformed JSON → exit 0 (defensive)", async () => {
    const { code } = await runHook("not json at all");
    expect(code).toBe(0);
  });

  test("path matches but file missing Required-reading marker → exit 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "flightplan-hook-"));
    await mkdir(join(root, "docs/sample/tasks/ui"), { recursive: true });
    const file = join(root, "docs/sample/tasks/ui/01-foo.md");
    await writeFile(file, "# Some other task file\n\nnot flightplan shape\n");
    const { code, stderr } = await runHook(payload(file));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    await rm(root, { recursive: true });
  });

  test("valid flightplan task → exit 0, no output", async () => {
    const { root, taskFile } = await makeTaskTree(VALID_TASK);
    const { code, stderr, stdout } = await runHook(payload(taskFile));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("");
    await rm(root, { recursive: true });
  });

  test("flightplan task with PLAN.md reference → exit 2 + stderr", async () => {
    const bad = VALID_TASK.replace("One sentence.", "See PLAN.md for context.");
    const { root, taskFile } = await makeTaskTree(bad);
    const { code, stderr } = await runHook(payload(taskFile));
    expect(code).toBe(2);
    expect(stderr).toMatch(/flightplan lint violations/);
    expect(stderr).toMatch(/self-containment/);
    await rm(root, { recursive: true });
  });

  test("a payload that escapes its slashes as \\/ still reaches the lint", async () => {
    const bad = VALID_TASK.replace("One sentence.", "See PLAN.md for context.");
    const { root, taskFile } = await makeTaskTree(bad);
    const { code } = await runHook(payload(taskFile).replaceAll("/", "\\/"));
    expect(code).toBe(2);
    await rm(root, { recursive: true });
  });

  test("a backslash-separated task path reaches the lint (real file; on POSIX one file name holding the backslashes)", async () => {
    const bad = VALID_TASK.replace("One sentence.", "See PLAN.md for context.");
    const root = await mkdtemp(join(tmpdir(), "flightplan-hook-"));
    const file = `${root}${sep}docs\\sample\\tasks\\ui\\01-foo.md`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bad);
    const { code, stderr } = await runHook(payload(file));
    expect(code).toBe(2);
    expect(stderr).toMatch(/flightplan lint violations/);
    expect(stderr).toMatch(/self-containment/);
    await rm(root, { recursive: true });
  });

  test("flightplan task missing Eval rubric → exit 2 + stderr", async () => {
    const bad = VALID_TASK.slice(0, VALID_TASK.indexOf("## Eval rubric"));
    const { root, taskFile } = await makeTaskTree(bad);
    const { code, stderr } = await runHook(payload(taskFile));
    expect(code).toBe(2);
    expect(stderr).toMatch(/rubric/);
    await rm(root, { recursive: true });
  });

  test("flightplan task with bad status → exit 2 + stderr", async () => {
    const bad = VALID_TASK.replace("**Status**: todo", "**Status**: pending");
    const { root, taskFile } = await makeTaskTree(bad);
    const { code, stderr } = await runHook(payload(taskFile));
    expect(code).toBe(2);
    expect(stderr).toMatch(/status/);
    await rm(root, { recursive: true });
  });

  test("current scaffolded header (annotated) → lint runs, valid task exits 0", async () => {
    const { root, taskFile } = await makeTaskTree(ANNOTATED_TASK);
    const { code, stderr, stdout } = await runHook(payload(taskFile));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("");
    await rm(root, { recursive: true });
  });

  test("current scaffolded header + malformed task → exit 2 with lint feedback", async () => {
    const bad = ANNOTATED_TASK.replace(
      "One sentence.",
      "See PLAN.md for context.",
    );
    const { root, taskFile } = await makeTaskTree(bad);
    const { code, stderr } = await runHook(payload(taskFile));
    expect(code).toBe(2);
    expect(stderr).toMatch(/flightplan lint violations/);
    expect(stderr).toMatch(/self-containment/);
    await rm(root, { recursive: true });
  });

  test("near-miss marker `Required reading later` → silent exit 0, though its body would fail the lint", async () => {
    const nearMiss = VALID_TASK.replace(
      "> **Required reading**:",
      "> **Required reading later**:",
    ).replace("One sentence.", "See PLAN.md for context.");
    const { root, taskFile } = await makeTaskTree(nearMiss);
    const { code, stderr } = await runHook(payload(taskFile));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    await rm(root, { recursive: true });
  });

  test("path filter rejects a bucket with dashes, which is not one kebab token", async () => {
    const root = await mkdtemp(join(tmpdir(), "flightplan-hook-"));
    await mkdir(join(root, "docs/sample/tasks/my-bucket"), { recursive: true });
    const file = join(root, "docs/sample/tasks/my-bucket/01-foo.md");
    await writeFile(file, VALID_TASK);
    const { code, stderr } = await runHook(payload(file));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    await rm(root, { recursive: true });
  });
});
