import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { BACKENDS } from "./backends";
import {
  executeRelay,
  parseFlags,
  writeFileCreatingDir,
  type RelayDeps,
} from "./relay";
import { CLI_DEFAULT, CONFIG_PATH, SUGGESTED_CONFIG_PATH } from "./shared";
import type { Mode, RunResult } from "./types";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  type CollectLiveOpts,
  type LiveRunResult,
} from "./live";

const RUN_DIR = "/tmp/relay/test-run";

function deps(overrides: Partial<RelayDeps> = {}): RelayDeps {
  const files = new Map<string, string>([
    ["/tmp/prompt.md", "built prompt"],
    ["/tmp/manual.md", "manual prompt"],
  ]);

  return {
    registry: BACKENDS,
    createTmpRunDir: () => RUN_DIR,
    buildPromptFile: () => "/tmp/prompt.md",
    readFile: (path) => files.get(path) ?? "",
    writeFile: (path, text) => {
      files.set(path, text);
    },
    ensureDir: () => {},
    fileExists: (path) => files.has(path),
    run: () => ({
      ok: true,
      stdout: "backend output",
      stderr: "",
      code: 0,
    }),
    stderr: () => {},
    stdout: () => {},
    env: {},
    resolveHerdScript: () => null,
    runLive: () =>
      Promise.resolve({
        ok: false,
        pending: false,
        error: "runLive not stubbed",
      }),
    collectLive: () =>
      Promise.resolve({
        ok: false,
        pending: false,
        error: "collectLive not stubbed",
      }),
    ...overrides,
  };
}

function liveDeps(overrides: Partial<RelayDeps> = {}): RelayDeps {
  return deps({
    env: { HERDR_ENV: "1" },
    resolveHerdScript: () => "/x/herd.ts",
    ...overrides,
  });
}

const liveOk: LiveRunResult = {
  ok: true,
  agentName: "relay-x-1234",
  text: "live answer",
};

describe("parseFlags", () => {
  it("extracts delegate task from positional text", () => {
    const parsed = parseFlags(["any", "delegate", "fix", "the", "bug"]);

    expect(parsed.backend).toBe("any");
    expect(parsed.mode).toBe("delegate");
    expect(parsed.positional).toBe("fix the bug");
  });

  it("extracts image prompt from positional text and keeps flags", () => {
    const parsed = parseFlags([
      "codex",
      "image",
      "--out",
      "out.png",
      "a",
      "quiet",
      "studio",
    ]);

    expect(parsed.flags.out).toBe("out.png");
    expect(parsed.positional).toBe("a quiet studio");
  });

  it("extracts a review task from positional text", () => {
    const parsed = parseFlags([
      "claude",
      "review",
      "review",
      "auth.ts",
      "for",
      "races",
    ]);

    expect(parsed.positional).toBe("review auth.ts for races");
  });

  it("parses every supported flag", () => {
    const parsed = parseFlags([
      "opencode",
      "delegate",
      "--task",
      "ship it",
      "--files",
      "a.ts, b.ts",
      "--model",
      "p/m",
      "--out",
      "x.png",
      "--git-scope",
      "none",
      "--no-project",
      "--prompt-file",
      "/tmp/manual.md",
      "--dangerous",
      "--no-ask",
      "--headless",
      "--keep-pane",
      "--wait-timeout",
      "30000",
      "--effort",
      "high",
    ]);

    expect(parsed.flags).toEqual({
      task: "ship it",
      files: ["a.ts", "b.ts"],
      model: "p/m",
      out: "x.png",
      gitScope: "none",
      noProject: true,
      promptFile: "/tmp/manual.md",
      dangerous: true,
      noAsk: true,
      headless: true,
      keepPane: true,
      waitTimeoutMs: 30000,
      effort: "high",
    });
  });

  it("rejects an unknown --effort level", () => {
    expect(() => parseFlags(["claude", "review", "--effort", "ultra"])).toThrow(
      "--effort must be one of low, medium, high, xhigh, max",
    );
  });

  it("does not validate backend names in the parser", () => {
    const parsed = parseFlags(["future-backend", "delegate"]);

    expect(parsed.backend).toBe("future-backend");
  });

  it("rejects missing flag values", () => {
    expect(() => parseFlags(["codex", "delegate", "--task"])).toThrow(
      "--task requires a value",
    );
  });

  it("rejects the removed review scope and focus flags", () => {
    expect(() => parseFlags(["codex", "review", "--scope", "main"])).toThrow(
      "Unknown flag: --scope",
    );
    expect(() =>
      parseFlags(["claude", "review", "--focus", "security"]),
    ).toThrow("Unknown flag: --focus");
  });

  it("rejects a non-positive --wait-timeout", () => {
    expect(() =>
      parseFlags(["codex", "delegate", "--wait-timeout", "abc"]),
    ).toThrow("--wait-timeout must be a positive number");
    expect(() =>
      parseFlags(["codex", "delegate", "--wait-timeout", "0"]),
    ).toThrow("--wait-timeout must be a positive number");
  });
});

describe("executeRelay", () => {
  it("marks headless backend processes as relay-delegated", async () => {
    let runOpts: { stdin?: string; env?: Record<string, string | undefined> } =
      {};

    await executeRelay(
      ["claude", "delegate", "--task", "inspect it", "--headless"],
      deps({
        env: { PATH: "/test/bin" },
        run: (_args, opts) => {
          runOpts = opts ?? {};
          return {
            ok: true,
            stdout: JSON.stringify({ result: "done" }),
            stderr: "",
            code: 0,
          };
        },
      }),
    );

    expect(runOpts.env).toEqual({
      PATH: "/test/bin",
      RELAY_DELEGATED: "1",
    });
  });

  it("marks live backend processes as relay-delegated", async () => {
    let liveOpts: Parameters<RelayDeps["runLive"]>[0] | undefined;

    await executeRelay(
      ["claude", "review"],
      liveDeps({
        runLive: (opts) => {
          liveOpts = opts;
          return Promise.resolve(liveOk);
        },
      }),
    );

    expect(liveOpts?.env).toEqual(["RELAY_DELEGATED=1"]);
  });

  it("merge-writes config set-model without running a backend", async () => {
    let spawned = false;
    const files = new Map<string, string>([
      [
        CONFIG_PATH,
        JSON.stringify({
          keep: true,
          models: {
            opencode: { review: "old-review" },
            claude: { delegate: "old-claude" },
          },
        }),
      ],
    ]);
    const ensuredDirs: string[] = [];
    const printed: string[] = [];

    const result = await executeRelay(
      ["config", "set-model", "opencode", "delegate", "provider/model"],
      deps({
        readFile: (path) => files.get(path) ?? "",
        writeFile: (path, text) => files.set(path, text),
        ensureDir: (path) => ensuredDirs.push(path),
        fileExists: (path) => files.has(path),
        run: () => {
          spawned = true;
          return { ok: true, stdout: "", stderr: "", code: 0 };
        },
        stdout: (text) => printed.push(text),
      }),
    );

    expect(result.code).toBe(0);
    expect(spawned).toBe(false);
    expect(ensuredDirs).toContain(dirname(CONFIG_PATH));
    expect(JSON.parse(files.get(CONFIG_PATH)!)).toEqual({
      keep: true,
      models: {
        opencode: {
          review: "old-review",
          delegate: "provider/model",
        },
        claude: { delegate: "old-claude" },
      },
    });
    expect(printed.join("")).toContain("Saved default model");
  });

  it("rejects config set-model for unknown backend or mode", async () => {
    const errors: string[] = [];
    const unknownBackend = await executeRelay(
      ["config", "set-model", "future", "delegate", "provider/model"],
      deps({ stderr: (text) => errors.push(text) }),
    );
    const unknownMode = await executeRelay(
      ["config", "set-model", "codex", "inspect", "provider/model"],
      deps({ stderr: (text) => errors.push(text) }),
    );

    expect(unknownBackend.code).toBe(1);
    expect(unknownMode.code).toBe(1);
    expect(errors.join("")).toContain("Unknown backend: future");
    expect(errors.join("")).toContain("Unknown mode: inspect");
  });

  it("rejects unknown backend at dispatch and lists registry keys", async () => {
    const errors: string[] = [];
    const result = await executeRelay(
      ["missing", "delegate"],
      deps({
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(1);
    expect(errors.join("")).toContain("codex|opencode|claude");
  });

  it("rejects unknown mode against the Mode union", async () => {
    const errors: string[] = [];
    const result = await executeRelay(
      ["codex", "inspect"],
      deps({
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(1);
    expect(errors.join("")).toContain("Unknown mode: inspect");
  });

  it("refuses --effort on a backend other than claude, rather than run it at a default", async () => {
    let spawned = false;
    const errors: string[] = [];

    const result = await executeRelay(
      ["codex", "review", "--effort", "high"],
      deps({
        run: () => {
          spawned = true;
          return { ok: true, stdout: "", stderr: "", code: 0 };
        },
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(1);
    expect(spawned).toBe(false);
    expect(errors.join("")).toContain("--effort is supported on claude only");
  });

  it("hands claude the model and effort on a headless review", async () => {
    let argv: string[] = [];

    const result = await executeRelay(
      [
        "claude",
        "review",
        "--prompt-file",
        "/tmp/manual.md",
        "--model",
        "opus",
        "--effort",
        "high",
        "--headless",
      ],
      deps({
        run: (cmd) => {
          argv = cmd;
          return { ok: true, stdout: "done", stderr: "", code: 0 };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(argv.slice(-4)).toEqual(["--model", "opus", "--effort", "high"]);
  });

  it("runs capability gate before spawning", async () => {
    let spawned = false;
    const errors: string[] = [];

    const result = await executeRelay(
      ["opencode", "image"],
      deps({
        run: () => {
          spawned = true;
          return { ok: true, stdout: "", stderr: "", code: 0 };
        },
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(1);
    expect(spawned).toBe(false);
    expect(errors.join("")).toContain("image is not supported on opencode");
  });

  it("builds a prompt internally for single-step delegate", async () => {
    let buildArgs: unknown;
    let promptArg = "";

    const result = await executeRelay(
      ["opencode", "delegate", "--task", "x"],
      deps({
        buildPromptFile: (args) => {
          buildArgs = args;
          return "/tmp/prompt.md";
        },
        run: (argv) => {
          promptArg = argv.at(-1) ?? "";
          return {
            ok: true,
            stdout: '{"type":"text","part":{"text":"done"}}',
            stderr: "",
            code: 0,
          };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(buildArgs).toMatchObject({ kind: "delegate", task: "x" });
    expect(promptArg).toBe("built prompt");
  });

  it("uses --prompt-file as an override", async () => {
    let built = false;
    let promptArg = "";

    const result = await executeRelay(
      ["opencode", "delegate", "--prompt-file", "/tmp/manual.md"],
      deps({
        buildPromptFile: () => {
          built = true;
          return "/tmp/prompt.md";
        },
        run: (argv) => {
          promptArg = argv.at(-1) ?? "";
          return {
            ok: true,
            stdout: '{"type":"text","part":{"text":"done"}}',
            stderr: "",
            code: 0,
          };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(built).toBe(false);
    expect(promptArg).toBe("manual prompt");
  });

  it("skips the prompt build for a native-review backend", async () => {
    let built = false;

    const result = await executeRelay(
      ["codex", "review"],
      deps({
        buildPromptFile: () => {
          built = true;
          return "/tmp/prompt.md";
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(built).toBe(false);
  });

  it("writes last.md and prints identical output on success", async () => {
    const writes = new Map<string, string>();
    const printed: string[] = [];

    const result = await executeRelay(
      ["claude", "review", "security"],
      deps({
        writeFile: (path, text) => writes.set(path, text),
        stdout: (text) => printed.push(text),
        run: (): RunResult => ({
          ok: true,
          stdout: "final review",
          stderr: "",
          code: 0,
        }),
      }),
    );

    expect(result.code).toBe(0);
    expect(result.lastMd).toBe(join(RUN_DIR, "last.md"));
    expect(writes.get(join(RUN_DIR, "last.md"))).toBe("final review");
    expect(printed.join("")).toBe("final review");
  });

  it("rejects codex image with no prompt before spawning", async () => {
    let spawned = false;
    const errors: string[] = [];

    const result = await executeRelay(
      ["codex", "image"],
      deps({
        run: () => {
          spawned = true;
          return { ok: true, stdout: "", stderr: "", code: 0 };
        },
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(1);
    expect(spawned).toBe(false);
    expect(errors.join("")).toContain("image mode requires a prompt");
  });

  it("rejects codex image with no --out before spawning a paid generation", async () => {
    let spawned = false;
    const errors: string[] = [];

    const result = await executeRelay(
      ["codex", "image", "a red bicycle"],
      deps({
        run: () => {
          spawned = true;
          return { ok: true, stdout: "", stderr: "", code: 0 };
        },
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(1);
    expect(spawned).toBe(false);
    expect(errors.join("")).toContain("image mode requires --out");
  });

  it("reviews uncommitted changes when no review task is provided", async () => {
    let invocation: string[] = [];
    const result = await executeRelay(
      ["codex", "review"],
      deps({
        run: (argv, opts) => {
          invocation = argv;
          expect(opts?.stdin).toContain("Review only the uncommitted changes");
          return { ok: true, stdout: "done", stderr: "", code: 0 };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(invocation).toEqual(["codex", "review", "--uncommitted", "-"]);
  });

  it("gives opencode the uncommitted review prompt when task is absent", async () => {
    let invocation: string[] = [];
    const result = await executeRelay(
      ["opencode", "review"],
      deps({
        run: (argv) => {
          invocation = argv;
          return {
            ok: true,
            stdout: '{"type":"text","part":{"text":"done"}}',
            stderr: "",
            code: 0,
          };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(invocation.at(-1)).toContain("Review only the uncommitted changes");
    expect(invocation.at(-1)).toContain("git diff --cached");
  });

  it("passes a provided review task without adding uncommitted scope", async () => {
    let invocation: string[] = [];
    const result = await executeRelay(
      ["claude", "review", "Review", "auth.ts", "for", "races"],
      deps({
        run: (argv) => {
          invocation = argv;
          return {
            ok: true,
            stdout: JSON.stringify({ result: "done" }),
            stderr: "",
            code: 0,
          };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(invocation.join(" ")).toContain("Review auth.ts for races");
    expect(invocation.join(" ")).not.toContain("uncommitted changes");
    expect(invocation.join(" ")).not.toContain("/code-review");
  });

  it("exits non-zero when a post-run step fails", async () => {
    const errors: string[] = [];

    const result = await executeRelay(
      ["codex", "image", "a quiet studio", "--out", "/tmp/relay/studio.png"],
      deps({
        run: () => ({ ok: true, stdout: "no png here", stderr: "", code: 0 }),
        fileExists: () => false,
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(1);
    expect(errors.join("")).toContain("No image found");
  });

  it("prints any backend's post-run text in place of the parsed output", async () => {
    const printed: string[] = [];
    const seen: string[] = [];
    const fourth = {
      name: "fourth",
      supports: new Set<Mode>(["delegate"]),
      invoke: () => ({ argv: ["fourth"] }),
      parseOutput: (raw: string) => `parsed ${raw}`,
      postRun: (_mode: Mode, parsed: string) => {
        seen.push(parsed);
        return { ok: true, text: "post-run text" };
      },
    };

    const result = await executeRelay(
      ["fourth", "delegate", "--task", "x"],
      deps({
        registry: { ...BACKENDS, fourth },
        stdout: (text) => printed.push(text),
      }),
    );

    expect(result.code).toBe(0);
    expect(seen).toEqual(["parsed backend output"]);
    expect(printed).toEqual(["post-run text"]);
  });

  it("exits with the CLI code on non-zero backend exit", async () => {
    const errors: string[] = [];
    const result = await executeRelay(
      ["claude", "review"],
      deps({
        run: () => ({
          ok: false,
          stdout: "",
          stderr: "failed",
          code: 7,
        }),
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(7);
    expect(errors.join("")).toBe(
      "claude failed (exit 7, model: CLI default): failed\n",
    );
  });

  it("surfaces the backend's stdout error and the model, never argv or the prompt", async () => {
    const errors: string[] = [];
    const result = await executeRelay(
      ["opencode", "delegate", "--task", "SECRET-PROMPT", "--model", "p/m"],
      deps({
        run: () => ({
          ok: false,
          stdout: JSON.stringify({
            type: "error",
            error: {
              name: "UnknownError",
              data: { message: "Model not found" },
            },
          }),
          stderr: "",
          code: 1,
        }),
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(1);
    expect(errors.join("")).toBe(
      "opencode failed (exit 1, model: p/m): Model not found\n",
    );
    expect(errors.join("")).not.toContain("SECRET-PROMPT");
  });

  it("prefers the parsed stdout error over a terse stderr code", async () => {
    const errors: string[] = [];
    await executeRelay(
      ["claude", "delegate", "--task", "x", "--headless"],
      deps({
        run: () => ({
          ok: false,
          stdout: JSON.stringify([
            { type: "result", is_error: true, result: "Bad model" },
          ]),
          stderr: "[claude-code:unrecognized_model] {}\n",
          code: 1,
        }),
        stderr: (text) => errors.push(text),
      }),
    );

    expect(errors.join("")).toBe(
      "claude failed (exit 1, model: CLI default): Bad model\n",
    );
  });

  it("omits -m for opencode when nothing is configured", async () => {
    let invocation: string[] = [];
    await executeRelay(
      ["opencode", "delegate", "--task", "x", "--headless"],
      deps({
        run: (argv) => {
          invocation = argv;
          return { ok: true, stdout: "", stderr: "", code: 0 };
        },
      }),
    );

    expect(invocation).not.toContain("-m");
  });

  it("uses the configured model when the flag is absent", async () => {
    let invocation: string[] = [];
    const config = JSON.stringify({
      models: { opencode: { delegate: "cfg/model" } },
    });
    await executeRelay(
      ["opencode", "delegate", "--task", "x", "--headless"],
      deps({
        fileExists: (path) => path === CONFIG_PATH || path === "/tmp/prompt.md",
        readFile: (path) => (path === CONFIG_PATH ? config : "built prompt"),
        run: (argv) => {
          invocation = argv;
          return { ok: true, stdout: "", stderr: "", code: 0 };
        },
      }),
    );

    expect(invocation.slice(2, 4)).toEqual(["-m", "cfg/model"]);
  });

  it("fails on a malformed config instead of running with the CLI default", async () => {
    const errors: string[] = [];
    let spawned = false;
    const result = await executeRelay(
      ["opencode", "delegate", "--task", "x", "--headless"],
      deps({
        fileExists: (path) => path === CONFIG_PATH,
        readFile: () => "{not json",
        run: () => {
          spawned = true;
          return { ok: true, stdout: "", stderr: "", code: 0 };
        },
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(1);
    expect(spawned).toBe(false);
    expect(errors.join("")).toContain(
      `Could not read relay config (${CONFIG_PATH})`,
    );
  });
});

describe("writeFileCreatingDir", () => {
  it("creates a missing parent directory before writing", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-write-"));
    try {
      const path = join(root, "gone", "last.md");
      writeFileCreatingDir(path, "text");
      expect(readFileSync(path, "utf-8")).toBe("text");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("executeRelay live routing", () => {
  it("stays headless when HERDR_ENV is unset, never scanning for herd.ts", async () => {
    let liveCalled = false;
    let ranHeadless = false;
    let resolved = false;

    const result = await executeRelay(
      ["opencode", "delegate", "--task", "x"],
      deps({
        resolveHerdScript: () => {
          resolved = true;
          return "/x/herd.ts";
        },
        runLive: () => {
          liveCalled = true;
          return Promise.resolve(liveOk);
        },
        run: () => {
          ranHeadless = true;
          return {
            ok: true,
            stdout: '{"type":"text","part":{"text":"done"}}',
            stderr: "",
            code: 0,
          };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(liveCalled).toBe(false);
    expect(ranHeadless).toBe(true);
    expect(resolved).toBe(false);
  });

  it("degrades to headless when the backend has no live path for the mode", async () => {
    const errors: string[] = [];
    let liveCalled = false;
    let ranHeadless = false;

    const result = await executeRelay(
      ["opencode", "delegate", "--task", "x"],
      liveDeps({
        registry: {
          ...BACKENDS,
          opencode: { ...BACKENDS.opencode!, invokeLive: () => null },
        },
        stderr: (text) => errors.push(text),
        runLive: () => {
          liveCalled = true;
          return Promise.resolve(liveOk);
        },
        run: () => {
          ranHeadless = true;
          return {
            ok: true,
            stdout: '{"type":"text","part":{"text":"done"}}',
            stderr: "",
            code: 0,
          };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(liveCalled).toBe(false);
    expect(ranHeadless).toBe(true);
    expect(errors.join("")).toContain("has no live path for delegate");
  });

  it("stays headless on --headless even inside herdr", async () => {
    let liveCalled = false;

    const result = await executeRelay(
      ["opencode", "delegate", "--task", "x", "--headless"],
      liveDeps({
        runLive: () => {
          liveCalled = true;
          return Promise.resolve(liveOk);
        },
        run: () => ({
          ok: true,
          stdout: '{"type":"text","part":{"text":"done"}}',
          stderr: "",
          code: 0,
        }),
      }),
    );

    expect(result.code).toBe(0);
    expect(liveCalled).toBe(false);
  });

  it("keeps image mode headless inside herdr", async () => {
    let liveCalled = false;

    await executeRelay(
      ["codex", "image", "a quiet studio"],
      liveDeps({
        runLive: () => {
          liveCalled = true;
          return Promise.resolve(liveOk);
        },
        run: () => ({ ok: true, stdout: "no png", stderr: "", code: 0 }),
        fileExists: () => false,
      }),
    );

    expect(liveCalled).toBe(false);
  });

  it("notes the fallback and runs headless when herd.ts is unresolvable", async () => {
    const errors: string[] = [];
    let ranHeadless = false;

    const result = await executeRelay(
      ["opencode", "delegate", "--task", "x"],
      liveDeps({
        resolveHerdScript: () => null,
        stderr: (text) => errors.push(text),
        run: () => {
          ranHeadless = true;
          return {
            ok: true,
            stdout: '{"type":"text","part":{"text":"done"}}',
            stderr: "",
            code: 0,
          };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(ranHeadless).toBe(true);
    expect(errors.join("")).toContain("live mode unavailable");
    expect(errors.join("")).toContain("running headless");
  });

  it("uses the same review task in a live TUI", async () => {
    let liveOpts: Parameters<RelayDeps["runLive"]>[0] | undefined;

    const result = await executeRelay(
      ["codex", "review", "Review", "changes", "since", "main"],
      liveDeps({
        runLive: (opts) => {
          liveOpts = opts;
          return Promise.resolve(liveOk);
        },
        run: () => {
          throw new Error("headless run must not be reached");
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(liveOpts!.mode).toBe("review");
    expect(liveOpts!.spec.agentBin).toBe("codex");
  });

  it("writes live-prompt.md with the review task + file contract", async () => {
    const writes = new Map<string, string>();
    let liveOpts: Parameters<RelayDeps["runLive"]>[0] | undefined;

    await executeRelay(
      ["codex", "review", "Review", "changes", "since", "main"],
      liveDeps({
        writeFile: (path, text) => writes.set(path, text),
        runLive: (opts) => {
          liveOpts = opts;
          return Promise.resolve(liveOk);
        },
      }),
    );

    const livePrompt = writes.get(join(RUN_DIR, "live-prompt.md"))!;
    expect(livePrompt).toContain("Review changes since main");
    expect(livePrompt).not.toContain("uncommitted changes");
    expect(livePrompt).toContain(join(RUN_DIR, "result.md"));
    expect(livePrompt.trimEnd().split("\n")).toContain(
      "- The file's last line must be exactly: ==== RELAY RESULT END ====",
    );

    expect(liveOpts!.bootstrapText).toContain(
      join(RUN_DIR, "live-prompt.md"),
    );
    expect(liveOpts!.bootstrapText).not.toContain("built prompt");
    expect(liveOpts!.resultPath).toBe(join(RUN_DIR, "result.md"));
  });

  // A live pane's TUI hands the agent an ask tool the headless form never gets,
  // and relay does not read the pane — so an unattended caller needs the contract
  // to arrive here, where no intermediate agent can paraphrase or skip it.
  it("appends the no-ask contract only under --no-ask", async () => {
    const promptFor = async (argv: string[]): Promise<string> => {
      const writes = new Map<string, string>();
      await executeRelay(
        argv,
        liveDeps({
          writeFile: (path, text) => writes.set(path, text),
          runLive: () => Promise.resolve(liveOk),
        }),
      );
      return writes.get(join(RUN_DIR, "live-prompt.md"))!;
    };

    const guarded = await promptFor([
      "codex",
      "delegate",
      "--no-ask",
      "Do",
      "the",
      "thing",
    ]);
    expect(guarded).toContain("Nobody is watching this run");
    expect(guarded).toContain("never wait on a reply");
    expect(guarded.indexOf("Nobody is watching this run")).toBeLessThan(
      guarded.indexOf(join(RUN_DIR, "result.md")),
    );

    const plain = await promptFor(["codex", "delegate", "Do", "the", "thing"]);
    expect(plain).not.toContain("Nobody is watching this run");
  });

  it("prints the live answer verbatim, bypassing parseOutput", async () => {
    const printed: string[] = [];
    const metadata: string[] = [];
    const writes = new Map<string, string>();
    const markdown = "# Verdict\n\n**looks good**\n";

    const result = await executeRelay(
      ["opencode", "delegate", "--task", "x"],
      liveDeps({
        stdout: (text) => printed.push(text),
        stderr: (text) => metadata.push(text),
        writeFile: (path, text) => writes.set(path, text),
        runLive: () =>
          Promise.resolve({
            ok: true,
            agentName: "relay-opencode-delegate-9f1c",
            text: markdown,
          }),
      }),
    );

    expect(result.code).toBe(0);
    expect(result.agentName).toBe("relay-opencode-delegate-9f1c");
    expect(printed.join("")).toBe(markdown);
    expect(writes.get(join(RUN_DIR, "last.md"))).toBe(markdown);
    expect(metadata.join("")).toContain("relay-opencode-delegate-9f1c");
    expect(metadata.join("")).toContain("pane closed");
    expect(printed.join("")).not.toContain("pane left open");
  });

  it("exits 0 with the pending report on live timeout", async () => {
    const printed: string[] = [];

    const result = await executeRelay(
      ["claude", "delegate", "--task", "slow thing"],
      liveDeps({
        stdout: (text) => printed.push(text),
        runLive: () =>
          Promise.resolve({
            ok: false,
            pending: true,
            agentName: "relay-claude-delegate-77aa",
            report: "still running — collect via herd wait/read",
          }),
      }),
    );

    expect(result.code).toBe(0);
    expect(result.pending).toBe(true);
    expect(result.agentName).toBe("relay-claude-delegate-77aa");
    expect(printed.join("")).toContain("still running");
  });

  it("passes --wait-timeout through to the live runner", async () => {
    let waitTimeoutMs = 0;

    await executeRelay(
      ["claude", "delegate", "--task", "x", "--wait-timeout", "5000"],
      liveDeps({
        runLive: (opts) => {
          waitTimeoutMs = opts.waitTimeoutMs;
          return Promise.resolve(liveOk);
        },
      }),
    );

    expect(waitTimeoutMs).toBe(5000);
  });

  it("passes --keep-pane through to the live runner", async () => {
    let keepPane = false;

    await executeRelay(
      ["claude", "delegate", "--task", "x", "--keep-pane"],
      liveDeps({
        runLive: (opts) => {
          keepPane = opts.keepPane;
          return Promise.resolve(liveOk);
        },
      }),
    );

    expect(keepPane).toBe(true);
  });

  it("falls back to headless on a pre-spawn live error, building the prompt once", async () => {
    const errors: string[] = [];
    let ranHeadless = false;
    let builds = 0;

    const result = await executeRelay(
      ["opencode", "delegate", "--task", "x"],
      liveDeps({
        buildPromptFile: () => {
          builds++;
          return "/tmp/prompt.md";
        },
        stderr: (text) => errors.push(text),
        runLive: () =>
          Promise.resolve({
            ok: false,
            pending: false,
            error: "failed to load herd.ts: boom",
          }),
        run: () => {
          ranHeadless = true;
          return {
            ok: true,
            stdout: '{"type":"text","part":{"text":"done"}}',
            stderr: "",
            code: 0,
          };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(ranHeadless).toBe(true);
    expect(errors.join("")).toContain("falling back to headless");
    expect(builds).toBe(1);
  });

  it("does NOT double-run headless after a post-spawn live error", async () => {
    const errors: string[] = [];
    let ranHeadless = false;

    const result = await executeRelay(
      ["opencode", "delegate", "--task", "x"],
      liveDeps({
        stderr: (text) => errors.push(text),
        runLive: () =>
          Promise.resolve({
            ok: false,
            pending: false,
            agentName: "relay-opencode-delegate-dead",
            error: "failed to send bootstrap",
          }),
        run: () => {
          ranHeadless = true;
          return { ok: true, stdout: "x", stderr: "", code: 0 };
        },
      }),
    );

    expect(result.code).toBe(1);
    expect(ranHeadless).toBe(false);
    expect(errors.join("")).toContain("Live run failed");
  });
});

describe("codex live delegation marker", () => {
  const outcomes: [string, LiveRunResult, number][] = [
    ["ok", liveOk, 0],
    ["failed", { ok: false, pending: false, agentName: "a", error: "e" }, 0],
    ["spawn-failed", { ok: false, pending: false, error: "e" }, 0],
    ["pending", { ok: false, pending: true, agentName: "a", report: "r" }, 1],
  ];

  for (const [label, outcome, left] of outcomes) {
    it(`leaves ${left} marker(s) after a ${label} run`, async () => {
      const home = mkdtempSync(join(tmpdir(), "relay-marker-"));
      try {
        let during = 0;
        await executeRelay(
          ["codex", "delegate", "--task", "x"],
          liveDeps({
            env: { HERDR_ENV: "1", Q_DELEGATION_HOME: home },
            runLive: () => {
              during = readdirSync(home).length;
              return Promise.resolve(outcome);
            },
          }),
        );

        expect(during).toBe(1);
        expect(readdirSync(home)).toHaveLength(left);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

describe("relay collect", () => {
  function collectDeps(
    result: LiveRunResult,
    overrides: Partial<RelayDeps> = {},
  ) {
    const out: string[] = [];
    const err: string[] = [];
    const seen: CollectLiveOpts[] = [];
    const d = liveDeps({
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      collectLive: (opts) => {
        seen.push(opts);
        return Promise.resolve(result);
      },
      ...overrides,
    });
    return { d, out, err, seen };
  }

  const ARGV = [
    "collect",
    "--agent",
    "relay-codex-delegate-ab12",
    "--result",
    "/tmp/relay/run/result.md",
  ];

  it("prints the collected answer on stdout and exits 0", async () => {
    const { d, out, seen } = collectDeps({
      ok: true,
      agentName: "relay-codex-delegate-ab12",
      text: "late answer",
    });

    const res = await executeRelay([...ARGV, "--wait-timeout", "480000"], d);

    expect(res.code).toBe(0);
    expect(out.join("")).toBe("late answer");
    expect(seen[0]).toEqual({
      agentName: "relay-codex-delegate-ab12",
      herdScriptPath: "/x/herd.ts",
      resultPath: "/tmp/relay/run/result.md",
      waitTimeoutMs: 480000,
      keepPane: false,
    });
  });

  it("exits 0 and reprints the report when it is STILL pending", async () => {
    const { d, out } = collectDeps({
      ok: false,
      pending: true,
      agentName: "relay-codex-delegate-ab12",
      report: "still running after 480s",
    });

    const res = await executeRelay(ARGV, d);

    expect(res.code).toBe(0);
    expect(res.pending).toBe(true);
    expect(out.join("")).toContain("still running");
  });

  it("exits 1 on a real failure — it must never fall back to a fresh run", async () => {
    const { d, err } = collectDeps({
      ok: false,
      pending: false,
      error: "cannot reattach to relay-codex-delegate-ab12: gone",
    });

    const res = await executeRelay(ARGV, d);

    expect(res.code).toBe(1);
    expect(err.join("")).toContain("cannot reattach");
  });

  it("defaults the wait budget and honours --keep-pane", async () => {
    const { d, seen } = collectDeps({
      ok: true,
      agentName: "a",
      text: "x",
    });

    await executeRelay([...ARGV, "--keep-pane"], d);

    expect(seen[0].waitTimeoutMs).toBe(DEFAULT_WAIT_TIMEOUT_MS);
    expect(seen[0].keepPane).toBe(true);
  });

  it("requires --agent and --result", async () => {
    const { d: d1, err: err1 } = collectDeps({
      ok: true,
      agentName: "a",
      text: "x",
    });
    expect(
      (await executeRelay(["collect", "--result", "/r.md"], d1)).code,
    ).toBe(1);
    expect(err1.join("")).toContain("--agent");

    const { d: d2, err: err2 } = collectDeps({
      ok: true,
      agentName: "a",
      text: "x",
    });
    expect((await executeRelay(["collect", "--agent", "a"], d2)).code).toBe(1);
    expect(err2.join("")).toContain("--result");
  });

  it("fails clearly when herd.ts cannot be resolved", async () => {
    const { d, err } = collectDeps(
      { ok: true, agentName: "a", text: "x" },
      { resolveHerdScript: () => null },
    );

    const res = await executeRelay(ARGV, d);

    expect(res.code).toBe(1);
    expect(err.join("")).toContain("herd.ts");
  });
});

describe("relay config check / apply", () => {
  const suggested = {
    version: 1790740000,
    models: { opencode: { delegate: "s/delegate", review: "s/review" } },
    suggestions: { opencode: { delegate: ["s/alt"], review: ["s/alt"] } },
  };

  function configDeps(userConfig?: string) {
    const files = new Map<string, string>([
      [SUGGESTED_CONFIG_PATH, JSON.stringify(suggested)],
    ]);
    if (userConfig !== undefined) files.set(CONFIG_PATH, userConfig);
    const out: string[] = [];
    const errors: string[] = [];
    return {
      files,
      out,
      errors,
      deps: deps({
        readFile: (path) => files.get(path) ?? "",
        writeFile: (path, text) => files.set(path, text),
        fileExists: (path) => files.has(path),
        stdout: (text) => out.push(text),
        stderr: (text) => errors.push(text),
      }),
    };
  }

  const check = async (userConfig?: string) => {
    const c = configDeps(userConfig);
    const result = await executeRelay(["config", "check"], c.deps);
    return { code: result.code, report: JSON.parse(c.out.join("")) };
  };

  it("reports current with exit 0 when the version matches", async () => {
    const { code, report } = await check(
      JSON.stringify({
        version: 1790740000,
        models: { opencode: { review: "u/r" } },
      }),
    );

    expect(code).toBe(0);
    expect(report.status).toBe("current");
    expect(report.models).toEqual({ opencode: { review: "u/r" } });
  });

  it("reports missing, no-version, and outdated with exit 3 and the suggestion", async () => {
    const missing = await check();
    const noVersion = await check(JSON.stringify({ models: {} }));
    const outdated = await check(JSON.stringify({ version: 1780000000 }));
    const semver = await check(JSON.stringify({ version: "0.9.0" }));

    expect(
      [missing, noVersion, outdated].map((r) => [r.code, r.report.status]),
    ).toEqual([
      [3, "missing"],
      [3, "no-version"],
      [3, "outdated"],
    ]);
    expect(outdated.report.version).toBe(1780000000);
    // A non-number version predates unix-time versioning and counts as absent.
    expect(semver.report.status).toBe("no-version");
    expect(outdated.report.suggested).toEqual(suggested);
  });

  it("reports malformed with exit 4, never as missing", async () => {
    const { code, report } = await check("{not json");

    expect(code).toBe(4);
    expect(report.status).toBe("malformed");
    expect(report.path).toBe(CONFIG_PATH);
  });

  it("merge keeps the user's models and fills only what is missing", async () => {
    const c = configDeps(
      JSON.stringify({
        keep: true,
        models: { opencode: { review: "u/r" }, claude: { delegate: "opus" } },
      }),
    );

    const result = await executeRelay(["config", "apply", "--merge"], c.deps);

    expect(result.code).toBe(0);
    expect(JSON.parse(c.files.get(CONFIG_PATH)!)).toEqual({
      keep: true,
      version: 1790740000,
      models: {
        opencode: { delegate: "s/delegate", review: "u/r" },
        claude: { delegate: "opus" },
      },
      applied: suggested.models,
    });
  });

  it("merge replaces a model apply wrote, and keeps one the user changed since", async () => {
    const c = configDeps(
      JSON.stringify({
        version: 1780000000,
        models: { opencode: { delegate: "old/delegate", review: "u/r" } },
        applied: {
          opencode: { delegate: "old/delegate", review: "old/review" },
        },
      }),
    );

    const result = await executeRelay(["config", "apply", "--merge"], c.deps);

    expect(result.code).toBe(0);
    expect(JSON.parse(c.files.get(CONFIG_PATH)!)).toEqual({
      version: 1790740000,
      models: { opencode: { delegate: "s/delegate", review: "u/r" } },
      applied: suggested.models,
    });
  });

  it("set-model leaves the applied record alone", async () => {
    const applied = { opencode: { delegate: "s/delegate" } };
    const c = configDeps(
      JSON.stringify({
        models: { opencode: { delegate: "s/delegate" } },
        applied,
      }),
    );

    await executeRelay(
      ["config", "set-model", "opencode", "delegate", "u/d"],
      c.deps,
    );

    expect(JSON.parse(c.files.get(CONFIG_PATH)!).applied).toEqual(applied);
  });

  it("overwrite replaces the user config with the suggested version and models", async () => {
    const c = configDeps(
      JSON.stringify({ keep: true, models: { claude: { delegate: "opus" } } }),
    );

    const result = await executeRelay(
      ["config", "apply", "--overwrite"],
      c.deps,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(c.files.get(CONFIG_PATH)!)).toEqual({
      version: 1790740000,
      models: suggested.models,
      applied: suggested.models,
    });
  });

  it("merge refuses a malformed config; overwrite replaces it", async () => {
    const merge = configDeps("{not json");
    const mergeResult = await executeRelay(
      ["config", "apply", "--merge"],
      merge.deps,
    );

    expect(mergeResult.code).toBe(1);
    expect(merge.errors.join("")).toContain("Could not read relay config");
    expect(merge.files.get(CONFIG_PATH)).toBe("{not json");

    const overwrite = configDeps("{not json");
    const overwriteResult = await executeRelay(
      ["config", "apply", "--overwrite"],
      overwrite.deps,
    );

    expect(overwriteResult.code).toBe(0);
    expect(JSON.parse(overwrite.files.get(CONFIG_PATH)!).version).toBe(
      1790740000,
    );
  });

  it("rejects apply without exactly one of --merge or --overwrite", async () => {
    const c = configDeps();

    expect((await executeRelay(["config", "apply"], c.deps)).code).toBe(1);
    expect(
      (
        await executeRelay(
          ["config", "apply", "--merge", "--overwrite"],
          c.deps,
        )
      ).code,
    ).toBe(1);
    expect(c.files.has(CONFIG_PATH)).toBe(false);
  });

  it("check reports a cli-default choice, and leaves a never-asked mode absent", async () => {
    const c = configDeps();
    await executeRelay(
      ["config", "set-model", "opencode", "delegate", CLI_DEFAULT],
      c.deps,
    );
    await executeRelay(["config", "check"], c.deps);

    expect(JSON.parse(c.out.at(-1)!).models).toEqual({
      opencode: { delegate: CLI_DEFAULT },
    });
  });

  it("runs without -m when the config says cli-default", async () => {
    let invocation: string[] = [];
    const config = JSON.stringify({
      models: { opencode: { delegate: CLI_DEFAULT } },
    });
    await executeRelay(
      ["opencode", "delegate", "--task", "x", "--headless"],
      deps({
        fileExists: (path) => path === CONFIG_PATH || path === "/tmp/prompt.md",
        readFile: (path) => (path === CONFIG_PATH ? config : "built prompt"),
        run: (argv) => {
          invocation = argv;
          return { ok: true, stdout: "", stderr: "", code: 0 };
        },
      }),
    );

    expect(invocation).not.toContain("-m");
    expect(invocation).not.toContain(CLI_DEFAULT);
  });
});
