import { describe, expect, it } from "bun:test";
import { BACKENDS } from "./backends";
import { executeRelay, parseFlags, type RelayDeps } from "./relay";
import type { RunResult } from "./types";

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
    fileExists: (path) => files.has(path),
    run: () => ({
      ok: true,
      stdout: "backend output",
      stderr: "",
      code: 0,
    }),
    stderr: () => {},
    stdout: () => {},
    ...overrides,
  };
}

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
});

describe("executeRelay", () => {
  it("rejects unknown backend at dispatch and lists registry keys", () => {
    const errors: string[] = [];
    const result = executeRelay(
      ["missing", "delegate"],
      deps({
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(1);
    expect(errors.join("")).toContain("codex|opencode|claude");
  });

  it("rejects unknown mode against the Mode union", () => {
    const errors: string[] = [];
    const result = executeRelay(
      ["codex", "inspect"],
      deps({
        stderr: (text) => errors.push(text),
      }),
    );

    expect(result.code).toBe(1);
    expect(errors.join("")).toContain("Unknown mode: inspect");
  });

  it("runs capability gate before spawning", () => {
    let spawned = false;
    const errors: string[] = [];

    const result = executeRelay(
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

  it("builds a prompt internally for single-step delegate", () => {
    let buildArgs: unknown;
    let promptArg = "";

    const result = executeRelay(
      ["opencode", "delegate", "--task", "x"],
      deps({
        buildPromptFile: (args) => {
          buildArgs = args;
          return "/tmp/prompt.md";
        },
        run: (argv) => {
          promptArg = argv.at(-1) ?? "";
          return { ok: true, stdout: "done", stderr: "", code: 0 };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(buildArgs).toMatchObject({ kind: "delegate", task: "x" });
    expect(promptArg).toBe("built prompt");
  });

  it("uses --prompt-file as an override", () => {
    let built = false;
    let promptArg = "";

    const result = executeRelay(
      ["opencode", "delegate", "--prompt-file", "/tmp/manual.md"],
      deps({
        buildPromptFile: () => {
          built = true;
          return "/tmp/prompt.md";
        },
        run: (argv) => {
          promptArg = argv.at(-1) ?? "";
          return { ok: true, stdout: "done", stderr: "", code: 0 };
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(built).toBe(false);
    expect(promptArg).toBe("manual prompt");
  });

  it("uses native strategy without building a prompt", () => {
    let built = false;

    const result = executeRelay(
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

  it("writes last.md and prints identical output on success", () => {
    const writes = new Map<string, string>();
    const printed: string[] = [];

    const result = executeRelay(
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

  it("rejects codex image with no prompt before spawning", () => {
    let spawned = false;
    const errors: string[] = [];

    const result = executeRelay(
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

  it("routes a review naming --files to the custom-files prompt strategy", () => {
    let built = false;

    const result = executeRelay(
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

  it("exits non-zero when a post-run step fails", () => {
    const errors: string[] = [];

    const result = executeRelay(
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

  it("exits with the CLI code on non-zero backend exit", () => {
    const errors: string[] = [];
    const result = executeRelay(
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
