import { describe, expect, it } from "bun:test";
import { BACKENDS } from "./backends";
import { executeRelay, parseFlags, type RelayDeps } from "./relay";
import { CONFIG_PATH } from "./shared";
import type { RunResult } from "./types";
import type { LiveRunResult } from "./live";

function deps(overrides: Partial<RelayDeps> = {}): RelayDeps {
  const files = new Map<string, string>([
    ["/tmp/prompt.md", "built prompt"],
    ["/tmp/manual.md", "manual prompt"],
  ]);

  return {
    registry: BACKENDS,
    createTmpRunDir: () => "/tmp/relay/test-run",
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
    ...overrides,
  };
}

// Shorthand for tests that take the live path: inside herdr, herd resolved.
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

  it("extracts review focus from positional text and explicit flags win later", () => {
    const parsed = parseFlags([
      "claude",
      "review",
      "--focus",
      "security",
      "performance",
    ]);

    expect(parsed.flags.focus).toBe("security");
    expect(parsed.positional).toBe("performance");
  });

  it("parses every supported flag", () => {
    const parsed = parseFlags([
      "opencode",
      "delegate",
      "--task",
      "ship it",
      "--files",
      "a.ts, b.ts",
      "--focus",
      "api",
      "--scope",
      "custom-files",
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
      "--headless",
      "--keep-pane",
      "--wait-timeout",
      "30000",
    ]);

    expect(parsed.flags).toEqual({
      task: "ship it",
      files: ["a.ts", "b.ts"],
      focus: "api",
      scope: "custom-files",
      model: "p/m",
      out: "x.png",
      gitScope: "none",
      noProject: true,
      promptFile: "/tmp/manual.md",
      dangerous: true,
      headless: true,
      keepPane: true,
      waitTimeoutMs: 30000,
    });
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
    expect(ensuredDirs).toContain(CONFIG_PATH.replace(/\/config\.json$/, ""));
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
          // opencode --format json → JSONL; parseOutput extracts the text part.
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
          // opencode --format json → JSONL; parseOutput extracts the text part.
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

  it("uses native strategy without building a prompt", async () => {
    let built = false;

    const result = await executeRelay(
      ["codex", "review", "--scope", "uncommitted"],
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
    expect(result.lastMd).toBe("/tmp/relay/test-run/last.md");
    expect(writes.get("/tmp/relay/test-run/last.md")).toBe("final review");
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

  it("routes a review naming --files to the custom-files prompt strategy", async () => {
    let built = false;

    const result = await executeRelay(
      ["codex", "review", "--files", "a.ts,b.ts"],
      deps({
        buildPromptFile: (args) => {
          built = true;
          // custom-files review must build a prompt (not native uncommitted)
          expect(args).toMatchObject({
            kind: "review",
            files: ["a.ts", "b.ts"],
          });
          return "/tmp/prompt.md";
        },
        run: (argv) => {
          // read-only exec prompt strategy, not `codex review --uncommitted`
          expect(argv).toContain("read-only");
          return { ok: true, stdout: "done", stderr: "", code: 0 };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(built).toBe(true);
  });

  it("exits non-zero when a post-run step fails", async () => {
    const errors: string[] = [];

    const result = await executeRelay(
      ["codex", "image", "a quiet studio"],
      deps({
        // No PNG will be found (future cutoff via real run), so postRun fails.
        run: () => ({ ok: true, stdout: "no png here", stderr: "", code: 0 }),
        fileExists: () => false,
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(1);
    expect(errors.join("")).toContain("No image found");
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
    expect(errors.join("")).toBe("failed");
  });
});

describe("executeRelay live routing", () => {
  it("stays headless when HERDR_ENV is unset", async () => {
    let liveCalled = false;
    let ranHeadless = false;

    const result = await executeRelay(
      ["opencode", "delegate", "--task", "x"],
      deps({
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

  it("forces the prompt strategy for a live review (no native codex review in a TUI)", async () => {
    let built = false;
    let liveOpts: Parameters<RelayDeps["runLive"]>[0] | undefined;

    const result = await executeRelay(
      ["codex", "review", "--scope", "base:main"],
      liveDeps({
        buildPromptFile: (args) => {
          built = true;
          expect(args).toMatchObject({ kind: "review" });
          return "/tmp/prompt.md";
        },
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
    // Headless codex review base:main is native — live must build a prompt.
    expect(built).toBe(true);
    expect(liveOpts!.mode).toBe("review");
    expect(liveOpts!.spec.agentBin).toBe("codex");
  });

  it("writes live-prompt.md with scope instruction + file contract, sends a one-line bootstrap", async () => {
    const writes = new Map<string, string>();
    let liveOpts: Parameters<RelayDeps["runLive"]>[0] | undefined;

    await executeRelay(
      ["codex", "review", "--scope", "base:main"],
      liveDeps({
        writeFile: (path, text) => writes.set(path, text),
        runLive: (opts) => {
          liveOpts = opts;
          return Promise.resolve(liveOk);
        },
      }),
    );

    const livePrompt = writes.get("/tmp/relay/test-run/live-prompt.md")!;
    expect(livePrompt).toContain("built prompt");
    expect(livePrompt).toContain("git diff main...");
    expect(livePrompt).toContain("/tmp/relay/test-run/result.md");
    expect(livePrompt.trimEnd().split("\n")).toContain(
      "- The file's last line must be exactly: ==== RELAY RESULT END ====",
    );

    expect(liveOpts!.bootstrapText).toContain(
      "/tmp/relay/test-run/live-prompt.md",
    );
    expect(liveOpts!.bootstrapText).not.toContain("built prompt");
    expect(liveOpts!.resultPath).toBe("/tmp/relay/test-run/result.md");
  });

  it("prints the live answer verbatim, bypassing parseOutput", async () => {
    const printed: string[] = [];
    const metadata: string[] = [];
    const writes = new Map<string, string>();
    // opencode's parseJsonl would reduce this to "" — live must NOT parse it.
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
    expect(writes.get("/tmp/relay/test-run/last.md")).toBe(markdown);
    // Live metadata (agent name, keep/close hint) rides stderr, not stdout.
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

  it("falls back to headless in the same invocation on a pre-spawn live error", async () => {
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

describe("real backend strategy matrix", () => {
  it("selects strategy through backend objects", () => {
    expect(BACKENDS.codex.strategy("delegate", {})).toBe("prompt");
    expect(BACKENDS.codex.strategy("review", { scope: "uncommitted" })).toBe(
      "native",
    );
    expect(BACKENDS.codex.strategy("review", { scope: "custom-files" })).toBe(
      "prompt",
    );
    expect(BACKENDS.codex.strategy("image", {})).toBe("native");
    expect(BACKENDS.opencode.strategy("delegate", {})).toBe("prompt");
    expect(BACKENDS.opencode.strategy("review", {})).toBe("prompt");
    expect(BACKENDS.claude.strategy("delegate", {})).toBe("prompt");
    expect(BACKENDS.claude.strategy("review", {})).toBe("native");
  });
});
