import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { QLabPlugin } from "./plugin";

const {
  guardVerdict,
  hookPayload,
  lintVerdict,
  withOpenCodeNote,
  COMMIT_COMMAND,
  FLIGHTPLAN_TASK,
} = QLabPlugin;

describe("guardVerdict", () => {
  test("returns an ask message verbatim", () => {
    const message = "⚠️ Stop here\nConfirm first.";
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "ask" },
      systemMessage: message,
    });

    expect(guardVerdict(0, stdout)).toBe(message);
  });

  test("returns null for a different decision", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "allow" },
      systemMessage: "ignored",
    });

    expect(guardVerdict(0, stdout)).toBeNull();
  });

  test("returns null for empty stdout", () => {
    expect(guardVerdict(0, "")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(guardVerdict(0, "not json")).toBeNull();
  });

  test("returns null for a non-zero exit", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "ask" },
      systemMessage: "ignored",
    });

    expect(guardVerdict(1, stdout)).toBeNull();
  });
});

describe("lintVerdict", () => {
  test("returns stderr for exit code 2", () => {
    expect(lintVerdict(2, "lint failed\n")).toBe("lint failed\n");
  });

  test("returns null for empty stderr", () => {
    expect(lintVerdict(2, "")).toBeNull();
  });

  test("returns null for exit code 0", () => {
    expect(lintVerdict(0, "ignored")).toBeNull();
  });

  test("returns null for another non-zero exit", () => {
    expect(lintVerdict(1, "ignored")).toBeNull();
  });
});

describe("hookPayload", () => {
  test.each([
    ["command", "git status"],
    ["file_path", "/tmp/example.ts"],
  ] as const)("round-trips a %s payload", (kind, value) => {
    expect(JSON.parse(hookPayload(kind, value))).toEqual({
      tool_input: { [kind]: value },
    });
  });

  test("preserves quotes, newlines, and multi-byte characters", () => {
    const command = `printf "double" 'single'\n你好 👋`;

    expect(JSON.parse(hookPayload("command", command))).toEqual({
      tool_input: { command },
    });
  });
});

// These two mirror the shell hooks' own first gates so the common tool call
// never pays a subprocess. A mismatch would either spawn on everything (slow)
// or skip a call the script would have acted on (a missed verdict).
describe("COMMIT_COMMAND", () => {
  test.each([
    ["git commit -m x", true],
    ["git   commit --amend", true],
    ["git commit", true],
    ["cd /tmp && git commit -m x", true],
    ["git status", false],
    ["git push", false],
    ["ls -la", false],
    ["gitcommit", false],
  ])("gates %p", (command, expected) =>
    expect(COMMIT_COMMAND.test(command)).toBe(expected),
  );
});

describe("FLIGHTPLAN_TASK", () => {
  test.each([
    ["docs/opencode-compat/tasks/review/01-final-review.md", true],
    ["/abs/repo/docs/x/tasks/runtime/02-installer.md", true],
    ["docs/x/tasks/skills/1-short.md", false],
    ["docs/x/tasks/Review/01-x.md", false],
    ["docs/x/review/01-x.md", false],
    ["opencode/plugin.ts", false],
    ["packages/monitor/skills/cockpit/SKILL.md", false],
  ])("gates %p", (path, expected) =>
    expect(FLIGHTPLAN_TASK.test(path)).toBe(expected),
  );
});

const VALID_TASK_WITH_PLAN_REF = `# RUNTIME-01: Lint fixture

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

> Each dimension 0\u20135; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 4\u20135 (pass) |
|---|---|---|
| Correctness | \u00d73 | correct |
| Test coverage | \u00d71 | covers edges |

See PLAN.md for the broader plan.
`;

// End-to-end through the real handler. The hook contract is the regression
// under test: after-hooks receive the arguments on the FIRST parameter
// (`input.args`) and the tool result on the second — the before-hook shape
// (`output.args`) throws on write/edit and fails the tool call.
describe("tool.execute.after handler", () => {
  const root = dirname(import.meta.dir);

  async function lintHook(
    filePath: string,
    tool = "write",
  ): Promise<{ output: string; thrown?: unknown }> {
    const hooks = await QLabPlugin({ directory: root });
    const output = { output: "" };
    try {
      await hooks["tool.execute.after"]({
        tool,
        sessionID: "ses_test",
        callID: "call_test",
        args: { filePath },
      }, output);
      return output;
    } catch (thrown) {
      return { output: output.output, thrown };
    }
  }

  test("a write outside the task tree is a silent no-op", async () => {
    const { output, thrown } = await lintHook("packages/foo/src/bar.ts");
    expect(thrown).toBeUndefined();
    expect(output).toBe("");
  });

  test("a non-write tool is a silent no-op even with a task path", async () => {
    const { output, thrown } = await lintHook(
      "docs/x/tasks/runtime/01-x.md",
      "bash",
    );
    expect(thrown).toBeUndefined();
    expect(output).toBe("");
  });

  test("appends lint feedback to the result for a violating task file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qlab-lint-"));
    try {
      const filePath = join(dir, "docs", "x", "tasks", "runtime", "01-x.md");
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, VALID_TASK_WITH_PLAN_REF);

      const { output, thrown } = await lintHook(filePath);
      expect(thrown).toBeUndefined();
      expect(output).toContain("flightplan lint violations");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("withOpenCodeNote", () => {
  test("appends the OpenCode spawn correction to a real message", () => {
    const note = withOpenCodeNote("Log the decision.");

    expect(note).toStartWith("Log the decision.\n\n");
    expect(note).toContain("task tool");
    // The Claude scripts name a tool OpenCode does not have; the note must say so.
    expect(note).toContain("fork");
  });

  test.each([null, "", "   \n"])("stays null for %p", (message) =>
    expect(withOpenCodeNote(message)).toBeNull(),
  );
});
