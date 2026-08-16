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
  stashPending,
  consumePending,
  GUIDANCE_CAP,
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
      await hooks["tool.execute.after"](
        {
          tool,
          sessionID: "ses_test",
          callID: "call_test",
          args: { filePath },
        },
        output,
      );
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

// S19: guidance must reach the model via the system prompt, not the TUI. A
// session.created run stashes the decision-log guidance; the transform hook
// pushes it into the system prompt exactly once.
describe("experimental.chat.system.transform", () => {
  const root = dirname(import.meta.dir);

  async function createdAndTransform(
    sessionID = "ses_guidance",
  ): Promise<{ system: string[] }> {
    const hooks = await QLabPlugin({ directory: root });
    await hooks.event({
      event: { type: "session.created", properties: { sessionID } },
    });
    const output = { system: ["base system prompt"] };
    await hooks["experimental.chat.system.transform"]({ sessionID }, output);
    return output;
  }

  test("injects the decision-log guidance into the system prompt", async () => {
    const { system } = await createdAndTransform();

    expect(system[0]).toBe("base system prompt");
    expect(system[1]).toContain("DECISION LOG ACTIVE");
    expect(system[1]).toContain("task tool");
  });

  test("consumes the guidance after the first request", async () => {
    const hooks = await QLabPlugin({ directory: root });
    const sessionID = "ses_once";
    await hooks.event({
      event: { type: "session.created", properties: { sessionID } },
    });
    const first = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID }, first);
    const second = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID }, second);

    expect(first.system).toHaveLength(2);
    expect(second.system).toHaveLength(1);
  });

  test("no-ops without a session id or without pending guidance", async () => {
    const hooks = await QLabPlugin({ directory: root });
    const output = { system: ["base"] };

    await hooks["experimental.chat.system.transform"]({}, output);
    expect(output.system).toHaveLength(1);

    await hooks["experimental.chat.system.transform"](
      { sessionID: "ses_unknown" },
      output,
    );
    expect(output.system).toHaveLength(1);
  });
});

// The stash/consume pair is the append-order branch the event handlers share —
// unit-testing the pure helpers covers the ordering the idle handler promises
// without forcing scribe-nudge to actually fire (git repo, code change,
// throttle, marker file).
describe("stashPending / consumePending", () => {
  test("appends in order and consumes them all at once", () => {
    const pending = new Map<string, string[]>();

    stashPending(pending, "ses_x", "created-guidance");
    stashPending(pending, "ses_x", "idle-nudge");

    expect(consumePending(pending, "ses_x")).toEqual([
      "created-guidance",
      "idle-nudge",
    ]);
    // Consumed: a second take finds nothing.
    expect(consumePending(pending, "ses_x")).toBeNull();
  });

  test("keeps sessions independent", () => {
    const pending = new Map<string, string[]>();

    stashPending(pending, "ses_a", "a");
    stashPending(pending, "ses_b", "b");
    expect(consumePending(pending, "ses_a")).toEqual(["a"]);
    expect(consumePending(pending, "ses_b")).toEqual(["b"]);
  });

  test("returns null when nothing is pending", () => {
    expect(consumePending(new Map(), "ses_missing")).toBeNull();
  });

  test("caps the map by evicting the oldest session", () => {
    const pending = new Map<string, string[]>();

    for (let i = 0; i < GUIDANCE_CAP + 5; i++) {
      stashPending(pending, `ses_${i}`, `guidance-${i}`);
    }

    expect(pending.size).toBe(GUIDANCE_CAP);
    // The five oldest sessions were evicted; the newest still resolve.
    expect(consumePending(pending, "ses_0")).toBeNull();
    expect(pending.has("ses_4")).toBe(false);
    expect(consumePending(pending, `ses_${GUIDANCE_CAP + 4}`)).toEqual([
      `guidance-${GUIDANCE_CAP + 4}`,
    ]);
  });

  test("re-stashing keeps a session alive past the cap", () => {
    const pending = new Map<string, string[]>();

    // The oldest key by first insertion, but the most recently active session.
    stashPending(pending, "ses_live", "created-guidance");
    for (let i = 0; i < GUIDANCE_CAP - 1; i++) {
      stashPending(pending, `ses_dead_${i}`, `guidance-${i}`);
    }
    stashPending(pending, "ses_live", "idle-nudge");
    // One more session pushes the map over the cap.
    stashPending(pending, "ses_new", "new-guidance");

    expect(pending.size).toBe(GUIDANCE_CAP);
    expect(consumePending(pending, "ses_live")).toEqual([
      "created-guidance",
      "idle-nudge",
    ]);
    // The genuinely-stalest session took the eviction instead.
    expect(pending.has("ses_dead_0")).toBe(false);
  });
});
