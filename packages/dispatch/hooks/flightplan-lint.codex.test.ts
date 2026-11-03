import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const hook = join(import.meta.dir, "flightplan-lint.codex.ts");
let root: string;
const task = "docs/sample/tasks/ui/01-shell.md";
const bad =
  "# UI-01: Shell\n\n> **Required reading** (read before starting):\n> - `../_context/shared.md`\n> **Status**: pending\n\n## Goal\nSee PLAN.md.\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dispatch-codex-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, content = bad) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function run(patch: string, tool = "apply_patch") {
  const result = Bun.spawnSync([process.execPath, hook], {
    cwd: tmpdir(),
    stdin: new TextEncoder().encode(
      JSON.stringify({
        cwd: root,
        hook_event_name: "PostToolUse",
        tool_name: tool,
        tool_input: { command: patch },
      }),
    ),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return result.stdout.toString();
}

test("reports task violations as PostToolUse context after a multi-file patch", () => {
  write(task);
  write("notes.md");
  const output = JSON.parse(
    run(
      `*** Begin Patch\n*** Update File: notes.md\n*** Add File: ${task}\n*** End Patch`,
    ),
  );
  expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  expect(output.hookSpecificOutput.additionalContext).toContain(
    "self-containment",
  );
  expect(output.hookSpecificOutput.additionalContext).toContain("status");
  expect(output.hookSpecificOutput.additionalContext).not.toContain("notes.md");
});

test("checks a renamed task at its destination with spaces in its path", () => {
  const moved = "docs/my plan/tasks/ui/02-moved.md";
  write(moved);
  expect(
    run(
      `*** Begin Patch\n*** Update File: ${task}\n*** Move to: ${moved}\n*** End Patch`,
    ),
  ).toContain("02-moved.md");
});

test("accepts absolute paths and deduplicates task files", () => {
  write(task);
  const output = JSON.parse(
    run(
      `*** Begin Patch\n*** Update File: ${join(root, task)}\n*** Update File: ${task}\n*** End Patch`,
    ),
  );
  expect(
    output.hookSpecificOutput.additionalContext.match(/\[self-containment\]/g),
  ).toHaveLength(1);
});

test("ignores deleted files, missing files, unrelated paths and shell tools", () => {
  write(task);
  write("notes.md");
  for (const patch of [
    `*** Begin Patch\n*** Delete File: ${task}\n*** End Patch`,
    "*** Begin Patch\n*** Add File: docs/sample/tasks/ui/99-missing.md\n*** End Patch",
    "*** Begin Patch\n*** Update File: notes.md\n*** End Patch",
  ])
    expect(run(patch)).toBe("");
  expect(
    run(`*** Begin Patch\n*** Update File: ${task}\n*** End Patch`, "Bash"),
  ).toBe("");
});

test("ignores malformed input and patch header lookalikes in added content", () => {
  write(task);
  expect(
    run(
      `*** Begin Patch\n*** Add File: notes.md\n+*** Update File: ${task}\n*** End Patch`,
    ),
  ).toBe("");
  for (const input of ["invalid", "null", "{}"]) {
    const result = Bun.spawnSync([process.execPath, hook], {
      stdin: new TextEncoder().encode(input),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  }
});

test("skips task-shaped files without a flightplan header", () => {
  write(task, "# Some other task\nSee PLAN.md.\n");
  expect(run(`*** Begin Patch\n*** Update File: ${task}\n*** End Patch`)).toBe(
    "",
  );
});

test("keeps a valid flightplan task silent", () => {
  write("docs/sample/tasks/_context/shared.md", "# Shared\n");
  write(
    task,
    `# UI-01: Shell

> **Required reading**:
> - \`../_context/shared.md\`
>
> **Depends on**: none
> **Status**: todo

## Goal
Build the shell.

## Files to create / modify
- shell.ts (new)

## Acceptance criteria
- [ ] Render the shell.

## Verification
- [ ] Run \`bun test\`.

## Eval rubric

> Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 4–5 (pass) |
|---|---|---|
| Correctness | ×3 | correct |
| Test coverage | ×1 | covers edges |
`,
  );
  expect(run(`*** Begin Patch\n*** Update File: ${task}\n*** End Patch`)).toBe(
    "",
  );
});
