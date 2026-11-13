import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { QLabPlugin } from "./plugin";

const realSpawn = Bun.spawn;
let spawnWithBinary: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
beforeEach(() => {
  // Bun's default spawn environment does not pick up test-time env changes.
  spawnWithBinary = spyOn(Bun, "spawn").mockImplementation(((
    ...args: Parameters<typeof Bun.spawn>
  ) => {
    const [command, options] = args;
    return realSpawn(command, { ...options, env: { ...process.env } });
  }) as typeof Bun.spawn);
});
afterEach(() => spawnWithBinary.mockRestore());

let stubDir: string;
const originalBinary = process.env.COCKPIT_BIN;
beforeAll(async () => {
  stubDir = await mkdtemp(
    join(dirname(import.meta.dir), ".cockpit-hook-test-"),
  );
  const binary = join(stubDir, "cockpit");
  await writeFile(
    binary,
    `#!/bin/sh
payload=$(cat)
case "$1 $2" in
  "hook session-start") printf '%s' 'DECISION LOG ACTIVE' ;;
  "hook stop") printf '%s' '{"hookSpecificOutput":{"additionalContext":"Log the decision."}}' ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  process.env.COCKPIT_BIN = binary;
});
afterAll(async () => {
  if (originalBinary === undefined) delete process.env.COCKPIT_BIN;
  else process.env.COCKPIT_BIN = originalBinary;
  await rm(stubDir, { recursive: true, force: true });
});

type PendingGuidance = { items: string[]; pushes: number };

const {
  guardVerdict,
  hookPayload,
  commentPayload,
  lintVerdict,
  withOpenCodeNote,
  stashPending,
  seedFromEvent,
  GUIDANCE_CAP,
  PENDING_GUIDANCE,
  PUSH_CAP,
  COMMIT_COMMAND,
  COMMENT_GUARDED,
  FLIGHTPLAN_TASK,
} = QLabPlugin;

type HookCallback = (event: any) => Promise<void> | void;
type Registered = {
  toolHooks: Map<string, HookCallback>;
  sessionHooks: Map<string, HookCallback>;
};

async function registerHooks(directory: string): Promise<Registered> {
  const toolHooks = new Map<string, HookCallback>();
  const sessionHooks = new Map<string, HookCallback>();
  const ctx = {
    location: { directory },
    event: { subscribe: async function* () {} },
    session: {
      hook: async (name: string, callback: HookCallback) => {
        sessionHooks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
    tool: {
      hook: async (name: string, callback: HookCallback) => {
        toolHooks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
  };
  await QLabPlugin.setup(ctx as never);
  return { toolHooks, sessionHooks };
}

function contentText(event: { result?: { content?: unknown } }): string {
  const content = event.result?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (part as { text?: string }).text ?? "")
      .join("");
  return "";
}

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

// End-to-end through the real handler. The V2 hook contract is the regression
// under test: the event carries `input` (the tool arguments) and `result` on
// the ONE event object, and the after-hook appends feedback to
// `result.content` — the old V1 two-parameter shape would throw here and fail
// the write after it has landed.
describe("tool execute.after handler", () => {
  const root = dirname(import.meta.dir);

  async function lintHook(
    filePath: string,
    tool = "write",
  ): Promise<{ output: string; thrown?: unknown }> {
    const { toolHooks } = await registerHooks(root);
    const event = {
      tool,
      input: { path: filePath },
      status: "completed",
      result: { content: [] as unknown[] },
    };
    try {
      await toolHooks.get("execute.after")!(event);
      return { output: contentText(event), thrown: undefined };
    } catch (thrown) {
      return { output: contentText(event), thrown };
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
      "shell",
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
      const lintCall = spawnWithBinary.mock.calls.find(([argv]) =>
        String((argv as string[])[1]).endsWith("flightplan-lint.sh"),
      );
      expect((lintCall?.[0] as string[])[0]).toBe("bash");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lints a task file the patch tool updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qlab-lint-"));
    try {
      const filePath = join(dir, "docs", "x", "tasks", "runtime", "01-x.md");
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, VALID_TASK_WITH_PLAN_REF);
      const { toolHooks } = await registerHooks(root);
      const event = {
        tool: "patch",
        input: {
          patchText: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n+x\n*** End Patch`,
        },
        status: "completed",
        result: { content: [] as unknown[], output: "Success." },
      };
      await toolHooks.get("execute.after")!(event);

      expect(contentText(event)).toContain("flightplan lint violations");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps the tool's output when the result carries no content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qlab-lint-"));
    try {
      const filePath = join(dir, "docs", "x", "tasks", "runtime", "01-x.md");
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, VALID_TASK_WITH_PLAN_REF);
      const { toolHooks } = await registerHooks(root);
      const event = {
        tool: "write",
        input: { path: filePath },
        status: "completed",
        result: {
          content: [] as unknown[],
          output: "Wrote file successfully.",
        },
      };
      await toolHooks.get("execute.after")!(event);

      expect(contentText(event)).toStartWith("Wrote file successfully.");
      expect(contentText(event)).toContain("flightplan lint violations");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("leaves an errored tool's result untouched", async () => {
    const { toolHooks } = await registerHooks(root);
    const event = {
      tool: "write",
      input: { path: "docs/x/tasks/runtime/01-x.md" },
      status: "error",
      result: { content: [{ type: "text", text: "the failure" }] },
    };
    await toolHooks.get("execute.after")!(event);

    expect(contentText(event)).toBe("the failure");
  });
});

describe("comment guard on execute.after", () => {
  const root = dirname(import.meta.dir);

  async function guardHook(
    args: Record<string, string>,
    tool = "write",
  ): Promise<string> {
    const { toolHooks } = await registerHooks(root);
    const event = {
      tool,
      input: args,
      status: "completed",
      result: { content: [] as unknown[] },
    };
    await toolHooks.get("execute.after")!(event);
    return contentText(event);
  }

  async function inTmp(
    name: string,
    body: string,
    run: (filePath: string) => Promise<string>,
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "qlab-guard-"));
    try {
      const filePath = join(dir, name);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, body);
      return await run(filePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("appends the guard question for a newly written comment block", async () => {
    const body = "x = 1\n# one\n# two\n# three\ny = 2\n";
    const output = await inTmp("user.rb", body, (filePath) =>
      guardHook({ path: filePath, content: body }),
    );

    expect(output).toContain("does it say why, or what?");
    expect(output).toContain("user.rb:2-4");
    expect(output).toContain("+ 2  # one");
  });

  test("guards a file the patch tool adds", async () => {
    const body = "x = 1\n# one\n# two\n# three\ny = 2\n";
    const output = await inTmp("user.rb", body, (filePath) =>
      guardHook(
        {
          patchText: [
            "*** Begin Patch",
            `*** Add File: ${filePath}`,
            ...body
              .trimEnd()
              .split("\n")
              .map((line) => `+${line}`),
            "*** End Patch",
          ].join("\n"),
        },
        "patch",
      ),
    );

    expect(output).toContain("user.rb:2-4");
  });

  test("guards only the comment lines a patch update adds, at the moved path", async () => {
    const body = "def bump\n  # one\n  # two\n  # three\n  @n += 1\nend\n";
    const output = await inTmp("lib/user.rb", body, (filePath) =>
      guardHook(
        {
          patchText: [
            "*** Begin Patch",
            `*** Update File: ${join(dirname(filePath), "old.rb")}`,
            `*** Move to: ${filePath}`,
            "@@ def bump",
            "+  # one",
            "+  # two",
            "+  # three",
            "   @n += 1",
            "*** End Patch",
          ].join("\n"),
        },
        "patch",
      ),
    );

    expect(output).toContain("user.rb:2-4");
  });

  test("resolves a relative patch path against the session's directory", async () => {
    const body = "x = 1\n# one\n# two\n# three\ny = 2\n";
    const output = await inTmp("user.rb", body, async (filePath) => {
      seedFromEvent({
        type: "session.created",
        data: {
          sessionID: "ses_patch",
          location: { directory: dirname(filePath) },
        },
      });
      const { toolHooks } = await registerHooks(root);
      const event = {
        tool: "patch",
        sessionID: "ses_patch",
        input: {
          patchText: [
            "*** Begin Patch",
            "*** Add File: user.rb",
            ...body
              .trimEnd()
              .split("\n")
              .map((line) => `+${line}`),
            "*** End Patch",
          ].join("\n"),
        },
        status: "completed",
        result: { content: [] as unknown[] },
      };
      await toolHooks.get("execute.after")!(event);
      PENDING_GUIDANCE.delete("ses_patch");
      return contentText(event);
    });

    expect(output).toContain("user.rb:2-4");
  });

  test("a patch that only deletes a file runs no guard", async () => {
    const output = await guardHook(
      {
        patchText:
          "*** Begin Patch\n*** Delete File: /nowhere/user.rb\n*** End Patch",
      },
      "patch",
    );

    expect(output).toBe("");
    expect(spawnWithBinary).not.toHaveBeenCalled();
  });

  test("appends to a string result instead of replacing it", async () => {
    const body = "x = 1\n# one\n# two\n# three\ny = 2\n";
    const output = await inTmp("user.rb", body, async (filePath) => {
      const { toolHooks } = await registerHooks(root);
      const event = {
        tool: "write",
        input: { path: filePath, content: body },
        status: "completed",
        result: { content: "wrote the file" },
      };
      await toolHooks.get("execute.after")!(event);
      return contentText(event);
    });

    expect(output).toStartWith("wrote the file");
    expect(output).toContain("does it say why, or what?");
  });

  test("translates OpenCode's camelCase edit args", async () => {
    const body = "def bump\n  # one\n  # two\n  # three\n  @n += 1\nend\n";
    const output = await inTmp("user.rb", body, (filePath) =>
      guardHook(
        {
          path: filePath,
          oldString: "def bump\n  @n += 1\nend",
          newString: body,
        },
        "edit",
      ),
    );

    expect(output).toContain("user.rb:2-4");
  });

  test("stays silent for a comment shorter than the block threshold", async () => {
    const body = "x = 1\n# why not what\ny = 2\n";
    const output = await inTmp("user.rb", body, (filePath) =>
      guardHook({ path: filePath, content: body }),
    );

    expect(output).toBe("");
  });

  test("stays silent when the edit adds no comment", async () => {
    const body = "x = 2\n";
    const output = await inTmp("user.rb", body, (filePath) =>
      guardHook(
        { path: filePath, oldString: "x = 1", newString: "x = 2" },
        "edit",
      ),
    );

    expect(output).toBe("");
  });

  test.each(["notes.md", "data.json", "docs/gen.py"])(
    "skips %s without spawning the guard",
    async (name) => {
      const body = "# a comment\n";
      expect(
        await inTmp(name, body, (filePath) =>
          guardHook({ path: filePath, content: body }),
        ),
      ).toBe("");
    },
  );
});

describe("commentPayload", () => {
  test("maps the write tool to Claude's Write shape", () => {
    expect(
      JSON.parse(commentPayload("write", { path: "a.rb", content: "# x" })),
    ).toEqual({
      tool_name: "Write",
      tool_input: {
        file_path: "a.rb",
        content: "# x",
        old_string: "",
        new_string: "",
      },
    });
  });

  test("maps the edit tool and drops non-string args to empty", () => {
    expect(
      JSON.parse(
        commentPayload("edit", {
          path: "a.rb",
          oldString: "a",
          newString: 7,
        }),
      ),
    ).toEqual({
      tool_name: "Edit",
      tool_input: {
        file_path: "a.rb",
        content: "",
        old_string: "a",
        new_string: "",
      },
    });
  });
});

describe("COMMENT_GUARDED", () => {
  // Absolute anchors. The cross-check below only proves the two sides agree,
  // so it stays green if both drift together; these pin the truth itself.
  test.each(["a.rb", "a.ts", "src/Rakefile", "src/Dockerfile.dev"])(
    "guards %s",
    (name) => expect(COMMENT_GUARDED.test(name)).toBe(true),
  );

  test("guards Windows paths to an extensionless build file", () => {
    expect(COMMENT_GUARDED.test("C:\\repo\\Rakefile")).toBe(true);
    expect(COMMENT_GUARDED.test("C:\\repo\\sub\\Dockerfile.dev")).toBe(true);
    expect(COMMENT_GUARDED.test("C:\\repo\\notes.txt")).toBe(false);
  });

  test("admits a path the hook's own policy refuses, so the policy lives in the hook alone", async () => {
    const { isGuardedPath } =
      await import("../packages/guard/hooks/comment-core.ts");

    expect(isGuardedPath("docs/gen.ts")).toBe(false);
    expect(COMMENT_GUARDED.test("docs/gen.ts")).toBe(true);
  });

  test.each(["a.md", "a.cfg", "LICENSE"])("leaves %s alone", (name) =>
    expect(COMMENT_GUARDED.test(name)).toBe(false),
  );

  // Enumerate from the tables, never a hand-listed sample: a sample is a third copy that drifts the same silent way, missing exactly the entry nobody remembered.
  test("agrees with the hook's own lookup, entry for entry", async () => {
    const { BY_EXT, BY_NAME, syntaxFor } =
      await import("../packages/guard/hooks/comment-core.ts");
    const covered = [
      ...Object.keys(BY_EXT).map((ext) => `src/a${ext}`),
      ...Object.keys(BY_NAME).map((name) => `src/${name}`),
      "src/Dockerfile.dev",
    ];
    const uncovered = [
      "src/a.md",
      "src/a.json",
      "src/a.txt",
      "src/a.cfg",
      "src/a.png",
      "src/a.lock",
      "src/LICENSE",
    ];

    expect(Object.keys(BY_EXT).length).toBeGreaterThan(70);
    const disagree = [...covered, ...uncovered].filter(
      (p) => COMMENT_GUARDED.test(p) !== (syntaxFor(p) !== null),
    );
    expect(disagree).toEqual([]);
  });
});

describe("withOpenCodeNote", () => {
  test("appends the OpenCode spawn correction to a real message", () => {
    const note = withOpenCodeNote("Log the decision.");

    expect(note).toStartWith("Log the decision.\n\n");
    expect(note).toContain("subagent tool");
    // The Claude scripts name a tool OpenCode does not have; the note must say so.
    expect(note).toContain("fork");
  });

  test.each([null, "", "   \n"])("stays null for %p", (message) =>
    expect(withOpenCodeNote(message)).toBeNull(),
  );
});

describe("session context hook", () => {
  // No Windows cockpit build, and the shim is a POSIX sh script.
  const cockpitTest = test.skipIf(process.platform === "win32");
  const root = dirname(import.meta.dir);

  async function runContextFor(
    sessionID?: string,
  ): Promise<(system: string[]) => Promise<string[]>> {
    const { sessionHooks } = await registerHooks(root);
    return async (system: string[]) => {
      const event = {
        sessionID,
        system: system.map((text) => ({ type: "text" as const, text })),
      };
      await sessionHooks.get("context")!(event);
      return event.system.map((part) => part.text);
    };
  }

  async function createdAndInject(
    sessionID = "ses_guidance",
  ): Promise<string[]> {
    QLabPlugin.seedFromEvent({ type: "session.created", data: { sessionID } });
    return await (
      await runContextFor(sessionID)
    )(["base system prompt"]);
  }

  cockpitTest(
    "injects the decision-log guidance into the system prompt",
    async () => {
      const system = await createdAndInject();

      expect(system[0]).toBe("base system prompt");
      expect(system[1]).toContain("DECISION LOG ACTIVE");
      expect(system[1]).toContain("subagent tool");
    },
  );

  cockpitTest(
    "the created seed lands before the first context hook (S20)",
    async () => {
      const sessionID = "ses_race";

      // An async stash used to lose the race to the first request; the
      // synchronous seed keeps the guidance visible from the instant the
      // event lands.
      QLabPlugin.seedFromEvent({
        type: "session.created",
        data: { sessionID },
      });
      const runContext = await runContextFor(sessionID);

      expect((await runContext(["base"]))[1]).toContain("DECISION LOG ACTIVE");
    },
  );

  cockpitTest(
    "materializes the seed once and replays the cache (S21)",
    async () => {
      const sessionID = "ses_cache";
      QLabPlugin.seedFromEvent({
        type: "session.created",
        data: { sessionID },
      });
      const runContext = await runContextFor(sessionID);

      const spawn = spyOn(Bun, "spawn");
      try {
        const outputs: string[][] = [];
        for (let i = 0; i < PUSH_CAP; i++) {
          outputs.push(await runContext(["base"]));
        }

        // Re-running the script per push assumes it is a pure function of its
        // input. scribe-nudge is not: it writes a marker and throttles, so a
        // re-run inside the same turn returns nothing and the later requests
        // push an empty message. Materialize once, then replay the strings.
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn.mock.calls[0]?.[0]).toEqual([
          join(root, "packages/monitor/skills/cockpit/bin/cockpit"),
          "hook",
          "session-start",
        ]);
        const stdin = spawn.mock.calls[0]?.[1]?.stdin as Blob;
        expect(JSON.parse(await stdin.text())).toEqual({
          session_id: sessionID,
          cwd: root,
          provider: "opencode",
        });
        for (const system of outputs) {
          expect(system[1]).toContain("DECISION LOG ACTIVE");
        }
      } finally {
        spawn.mockRestore();
      }
    },
  );

  cockpitTest(
    "rides the primary request, a tool continuation and a retry, then stops (S21)",
    async () => {
      expect(PUSH_CAP).toBe(3);
      const sessionID = "ses_cap";
      QLabPlugin.seedFromEvent({
        type: "session.created",
        data: { sessionID },
      });
      const runContext = await runContextFor(sessionID);

      const outputs: string[][] = [];
      for (let i = 0; i < PUSH_CAP + 2; i++) {
        outputs.push(await runContext(["base"]));
    }

      for (const system of outputs.slice(0, PUSH_CAP)) {
        expect(system).toHaveLength(2);
    }
      for (const system of outputs.slice(PUSH_CAP)) {
        expect(system).toHaveLength(1);
    }
    },
  );

  cockpitTest(
    "a materialized message spelling a seed's name is replayed, never re-run, because seeds start with NUL",
    async () => {
      PENDING_GUIDANCE.set("ses_spelled", {
        items: ["created-guidance", "idle-nudge"],
        pushes: 1,
      });
      const runContext = await runContextFor("ses_spelled");

      expect(await runContext(["base"])).toEqual([
        "base",
        "created-guidance",
        "idle-nudge",
      ]);
      expect(spawnWithBinary).not.toHaveBeenCalled();
      PENDING_GUIDANCE.delete("ses_spelled");
    },
  );

  cockpitTest(
    "session.idle retires the turn's entry and seeds the nudge (S21)",
    async () => {
      const sessionID = "ses_turn";
      QLabPlugin.seedFromEvent({
        type: "session.created",
        data: { sessionID },
      });
      const runContext = await runContextFor(sessionID);

      const first = await runContext(["base"]);
      expect(first[1]).toContain("DECISION LOG ACTIVE");

      // Turn over: the created guidance must not ride the next turn's requests.
      // The nudge script may or may not push in this environment (it gates on
      // the repo's change signature), but whatever it does, the created
      // guidance — identified by its unique "DECISION LOG ACTIVE" line — is gone.
      QLabPlugin.seedFromEvent({ type: "session.idle", data: { sessionID } });
      const second = await runContext(["base"]);
      expect(second.join("\n")).not.toContain("DECISION LOG ACTIVE");
    },
  );

  cockpitTest(
    "execution.succeeded is a V2 turn boundary and seeds the nudge",
    async () => {
      // V2 on 2.2.7: a CLI turn ends with execution.succeeded and
      // session.idle never arrives, so the nudge must seed from this event.
      const sessionID = "ses_exec";
      QLabPlugin.seedFromEvent({
        type: "session.created",
        data: { sessionID },
      });
      const runContext = await runContextFor(sessionID);
      await runContext(["base"]);

      QLabPlugin.seedFromEvent({
        type: "session.execution.succeeded",
        data: { sessionID },
      });
      const next = await runContext(["base"]);
      expect(next.join("\n")).not.toContain("DECISION LOG ACTIVE");
    },
  );

  test("ignores events without a session id", () => {
    const pending = PENDING_GUIDANCE.size;
    seedFromEvent({ type: "session.created" });
    seedFromEvent({ type: "session.execution.succeeded", data: {} });

    expect(PENDING_GUIDANCE.size).toBe(pending);
  });

  test("seeds the session cwd from the event's location", () => {
    seedFromEvent({
      type: "session.created",
      data: {
        sessionID: "ses_cwd",
        location: { directory: "/repo/one" },
      },
    });

    expect(PENDING_GUIDANCE.get("ses_cwd")?.cwd).toBe("/repo/one");
    PENDING_GUIDANCE.delete("ses_cwd");
  });

  test("stores no cwd when the event has no location", () => {
    seedFromEvent({ type: "session.created", data: { sessionID: "ses_cwd2" } });

    expect(PENDING_GUIDANCE.get("ses_cwd2")?.cwd).toBeUndefined();
    PENDING_GUIDANCE.delete("ses_cwd2");
  });

  test("a turn boundary never invents a cwd for a session it has not seen created", () => {
    seedFromEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_resumed" },
    });

    expect(PENDING_GUIDANCE.get("ses_resumed")?.cwd).toBeUndefined();
    PENDING_GUIDANCE.delete("ses_resumed");
  });

  test("keeps the session cwd across a turn boundary", () => {
    seedFromEvent({
      type: "session.created",
      data: {
        sessionID: "ses_cwd3",
        location: { directory: "/repo/two" },
      },
    });
    seedFromEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_cwd3" },
    });

    expect(PENDING_GUIDANCE.get("ses_cwd3")?.cwd).toBe("/repo/two");
    PENDING_GUIDANCE.delete("ses_cwd3");
  });

  for (const type of [
    "session.execution.failed",
    "session.execution.interrupted",
  ]) {
    test(`${type} retires the turn's guidance and seeds no nudge`, () => {
      seedFromEvent({
        type: "session.created",
        data: { sessionID: "ses_end", location: { directory: "/repo/end" } },
      });
      seedFromEvent({ type, data: { sessionID: "ses_end" } });

      expect(PENDING_GUIDANCE.get("ses_end")).toEqual({
        items: [],
        pushes: 0,
        cwd: "/repo/end",
      });
      PENDING_GUIDANCE.delete("ses_end");
    });
  }

  cockpitTest(
    "runs the stop hook through the shim with the OpenCode payload",
    async () => {
      const sessionID = "ses_stop_argv";
      QLabPlugin.seedFromEvent({ type: "session.idle", data: { sessionID } });
      const system = await (await runContextFor(sessionID))(["base"]);

      expect(spawnWithBinary.mock.calls[0]?.[0]).toEqual([
        join(root, "packages/monitor/skills/cockpit/bin/cockpit"),
        "hook",
        "stop",
      ]);
      const stdin = spawnWithBinary.mock.calls[0]?.[1]?.stdin as Blob;
      expect(JSON.parse(await stdin.text())).toEqual({
        session_id: sessionID,
        cwd: root,
        provider: "opencode",
      });
      expect(system[1]).toContain("Log the decision.");
    },
  );

  test("no-ops without a session id or without pending guidance", async () => {
    const withoutSession = await runContextFor(undefined);
    expect(await withoutSession(["base"])).toHaveLength(1);

    const unknown = await runContextFor("ses_unknown");
    expect(await unknown(["base"])).toHaveLength(1);
  });
});

// The stash helper is the map branch the event handlers share — unit-testing
// the pure helper covers the LRU behavior without forcing the scripts to run.
describe("stashPending", () => {
  test("replaces the session's entry, never appends", () => {
    const pending = new Map<string, PendingGuidance>();

    stashPending(pending, "ses_x", { items: ["created"], pushes: 1 });
    stashPending(pending, "ses_x", { items: ["idle"], pushes: 0 });

    expect(pending.get("ses_x")).toEqual({ items: ["idle"], pushes: 0 });
    expect(pending.size).toBe(1);
  });

  test("keeps sessions independent", () => {
    const pending = new Map<string, PendingGuidance>();

    stashPending(pending, "ses_a", { items: ["a"], pushes: 0 });
    stashPending(pending, "ses_b", { items: ["b"], pushes: 1 });
    expect(pending.get("ses_a")).toEqual({ items: ["a"], pushes: 0 });
    expect(pending.get("ses_b")).toEqual({ items: ["b"], pushes: 1 });
  });

  test("re-stashing keeps a session alive past the cap", () => {
    const pending = new Map<string, PendingGuidance>();

    // The oldest key by first insertion, but the most recently active session.
    // `set` on an existing key keeps its original position, so without the
    // delete-before-set this one is evicted first.
    stashPending(pending, "ses_live", { items: ["created"], pushes: 0 });
    for (let i = 0; i < GUIDANCE_CAP - 1; i++) {
      stashPending(pending, `ses_dead_${i}`, {
        items: [`guidance-${i}`],
        pushes: 0,
      });
    }
    stashPending(pending, "ses_live", { items: ["idle"], pushes: 0 });
    // One more session pushes the map over the cap.
    stashPending(pending, "ses_new", { items: ["new"], pushes: 0 });

    expect(pending.size).toBe(GUIDANCE_CAP);
    expect(pending.get("ses_live")).toEqual({ items: ["idle"], pushes: 0 });
    // The genuinely-stalest session took the eviction instead.
    expect(pending.has("ses_dead_0")).toBe(false);
  });

  test("caps the map by evicting the oldest session", () => {
    const pending = new Map<string, PendingGuidance>();

    for (let i = 0; i < GUIDANCE_CAP + 5; i++) {
      stashPending(pending, `ses_${i}`, {
        items: [`guidance-${i}`],
        pushes: 0,
      });
    }

    expect(pending.size).toBe(GUIDANCE_CAP);
    // The five oldest sessions were evicted; the newest still resolve.
    expect(pending.has("ses_0")).toBe(false);
    expect(pending.has("ses_4")).toBe(false);
    expect(pending.get(`ses_${GUIDANCE_CAP + 4}`)).toEqual({
      items: [`guidance-${GUIDANCE_CAP + 4}`],
      pushes: 0,
    });
  });

  test("re-stashing keeps a session alive past the cap", () => {
    const pending = new Map<string, PendingGuidance>();

    // The oldest key by first insertion, but the most recently active session.
    stashPending(pending, "ses_live", { items: ["created"], pushes: 2 });
    for (let i = 0; i < GUIDANCE_CAP - 1; i++) {
      stashPending(pending, `ses_dead_${i}`, {
        items: [`guidance-${i}`],
        pushes: 0,
      });
    }
    stashPending(pending, "ses_live", { items: ["idle"], pushes: 0 });
    // One more session pushes the map over the cap.
    stashPending(pending, "ses_new", { items: ["new-guidance"], pushes: 0 });

    expect(pending.size).toBe(GUIDANCE_CAP);
    expect(pending.get("ses_live")).toEqual({ items: ["idle"], pushes: 0 });
    // The genuinely-stalest session took the eviction instead.
    expect(pending.has("ses_dead_0")).toBe(false);
  });
});

describe("hooks run in the session's own directory, never the server's", () => {
  const scriptCwd = (suffix: string) =>
    (
      spawnWithBinary.mock.calls.find(([argv]) =>
        String((argv as string[])[1]).endsWith(suffix),
      )?.[1] as { cwd?: string } | undefined
    )?.cwd;

  test("the branch guard and the comment guard take the cwd session.created named", async () => {
    const instance = await mkdtemp(join(tmpdir(), "qlab-instance-"));
    const session = await mkdtemp(join(tmpdir(), "qlab-session-"));
    try {
      seedFromEvent({
        type: "session.created",
        data: { sessionID: "ses_where", location: { directory: session } },
      });
      const { toolHooks } = await registerHooks(instance);
      await toolHooks.get("execute.before")!({
        tool: "shell",
        sessionID: "ses_where",
        input: { command: "git commit -m x" },
      });
      await toolHooks.get("execute.after")!({
        tool: "write",
        sessionID: "ses_where",
        input: { path: join(session, "a.ts"), content: "" },
        status: "completed",
        result: { content: [] },
      });

      expect(scriptCwd("check-branch.sh")).toBe(session);
      expect(scriptCwd("comment-guard.ts")).toBe(session);
    } finally {
      PENDING_GUIDANCE.delete("ses_where");
      await rm(instance, { recursive: true, force: true });
      await rm(session, { recursive: true, force: true });
    }
  });

  test("a session it never saw created falls back to the hook's own instance", async () => {
    const instance = await mkdtemp(join(tmpdir(), "qlab-instance-"));
    try {
      const { toolHooks } = await registerHooks(instance);
      await toolHooks.get("execute.before")!({
        tool: "shell",
        sessionID: "ses_unseen",
        input: { command: "git commit -m x" },
      });

      expect(scriptCwd("check-branch.sh")).toBe(instance);
    } finally {
      await rm(instance, { recursive: true, force: true });
    }
  });
});

describe("module shape", () => {
  test("exports only the plugin, because a stray export once kept it from loading (S18)", async () => {
    const module = await import("./plugin");

    expect(Object.keys(module).sort()).toEqual(["QLabPlugin", "default"]);
    expect(module.default).toBe(QLabPlugin);
  });
});
