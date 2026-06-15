import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { formatPrompt, buildPromptFile } from "./relay-prompt";
import { rmSync, existsSync, readFileSync } from "fs";
import { TMP_ROOT } from "./shared";
import type { FormatOptions, PromptKind } from "./relay-prompt";

describe("formatPrompt", () => {
  const baseContext = "# Test Context\nSome git and file info";

  describe("review mode", () => {
    it("should format a review prompt with focus", () => {
      const options: FormatOptions = {
        kind: "review",
        context: baseContext,
        focus: "null safety checks",
        task: "",
        files: [],
      };

      const result = formatPrompt(options);

      expect(result).toContain(baseContext);
      expect(result).toContain("---");
      expect(result).toContain(
        "Review the above for code quality, bugs, and improvements.",
      );
      expect(result).toContain("Focus: null safety checks");
      expect(result).toContain(
        "Analyze only — do not modify any files; produce findings as a report.",
      );
    });

    it("should use default focus when not provided", () => {
      const options: FormatOptions = {
        kind: "review",
        context: baseContext,
        focus: "",
        task: "",
        files: [],
      };

      const result = formatPrompt(options);

      expect(result).toContain(
        "Focus: general code quality, bugs, and improvements",
      );
    });

    it("should not contain backend-specific names", () => {
      const options: FormatOptions = {
        kind: "review",
        context: baseContext,
        focus: "performance",
        task: "",
        files: [],
      };

      const result = formatPrompt(options);

      expect(result).not.toContain("codex");
      expect(result).not.toContain("opencode");
      expect(result).not.toContain("claude");
    });

    it("should include read-only instruction", () => {
      const options: FormatOptions = {
        kind: "review",
        context: baseContext,
        focus: "security",
        task: "",
        files: [],
      };

      const result = formatPrompt(options);

      expect(result).toContain("Analyze only — do not modify any files");
    });
  });

  describe("delegate mode", () => {
    it("should format a delegate prompt with task", () => {
      const options: FormatOptions = {
        kind: "delegate",
        context: baseContext,
        focus: "",
        task: "Add validation to user input",
        files: ["src/form.ts", "src/validator.ts"],
      };

      const result = formatPrompt(options);

      expect(result).toContain(baseContext);
      expect(result).toContain("---");
      expect(result).toContain("Task: Add validation to user input");
      expect(result).toContain("Execution constraints:");
      expect(result).toContain("Modify only the files needed for this task");
      expect(result).toContain(
        "If possible, stay within: src/form.ts, src/validator.ts",
      );
      expect(result).toContain("Do not revert user changes");
      expect(result).toContain("Do not create commits");
      expect(result).toContain(
        "After finishing, list changed files and verification commands/results",
      );
    });

    it("should use default file scope when none provided", () => {
      const options: FormatOptions = {
        kind: "delegate",
        context: baseContext,
        focus: "",
        task: "Refactor the parser",
        files: [],
      };

      const result = formatPrompt(options);

      expect(result).toContain("stay within: (no explicit file scope)");
    });

    it("should throw when task is missing", () => {
      const options: FormatOptions = {
        kind: "delegate",
        context: baseContext,
        focus: "",
        task: "",
        files: ["src/app.ts"],
      };

      expect(() => formatPrompt(options)).toThrow("Delegate task is required");
    });

    it("should not contain backend-specific names", () => {
      const options: FormatOptions = {
        kind: "delegate",
        context: baseContext,
        focus: "",
        task: "Add a new feature",
        files: ["src/feature.ts"],
      };

      const result = formatPrompt(options);

      expect(result).not.toContain("codex");
      expect(result).not.toContain("opencode");
      expect(result).not.toContain("claude");
    });

    it("should include execution constraints", () => {
      const options: FormatOptions = {
        kind: "delegate",
        context: baseContext,
        focus: "",
        task: "Fix the bug",
        files: ["src/bug.ts"],
      };

      const result = formatPrompt(options);

      expect(result).toContain("Execution constraints:");
      expect(result).toContain("- Modify only the files needed for this task");
      expect(result).toContain(
        "- Do not revert user changes or unrelated dirty work",
      );
      expect(result).toContain("- Do not create commits");
    });
  });

  describe("unknown kind", () => {
    it("should throw for invalid prompt kind", () => {
      const options = {
        kind: "invalid" as PromptKind,
        context: baseContext,
        focus: "",
        task: "test",
        files: [],
      };

      expect(() => formatPrompt(options)).toThrow("Unknown prompt kind");
    });
  });

  describe("prompt structure", () => {
    it("should separate context from prompt instructions with ---", () => {
      const options: FormatOptions = {
        kind: "review",
        context: baseContext,
        focus: "test",
        task: "",
        files: [],
      };

      const result = formatPrompt(options);
      const parts = result.split("\n\n---\n\n");

      expect(parts.length).toBe(2);
      expect(parts[0]).toBe(baseContext);
      expect(parts[1]).toContain("Review the above");
    });
  });
});

describe("buildPromptFile", () => {
  beforeEach(() => {
    // Clean up any test tmp files before each test
    try {
      if (existsSync(TMP_ROOT)) {
        rmSync(TMP_ROOT, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  afterEach(() => {
    // Clean up after each test
    try {
      if (existsSync(TMP_ROOT)) {
        rmSync(TMP_ROOT, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  it("should create a prompt file for review", () => {
    const promptPath = buildPromptFile({
      kind: "review",
      files: [],
      focus: "test focus",
      task: "",
      gitScope: "none",
      noProject: true,
    });

    expect(promptPath).toContain("review-prompt.md");
    expect(existsSync(promptPath)).toBe(true);

    const content = readFileSync(promptPath, "utf-8");
    expect(content).toContain("Review the above");
    expect(content).toContain("Analyze only");
  });

  it("should create a prompt file for delegate", () => {
    const promptPath = buildPromptFile({
      kind: "delegate",
      files: ["test.ts"],
      focus: "",
      task: "Test task",
      gitScope: "none",
      noProject: true,
    });

    expect(promptPath).toContain("delegate-prompt.md");
    expect(existsSync(promptPath)).toBe(true);

    const content = readFileSync(promptPath, "utf-8");
    expect(content).toContain("Task: Test task");
    expect(content).toContain("Execution constraints:");
  });

  it("should exit with error for delegate without task", () => {
    const originalExit = process.exit;
    const originalError = console.error;

    let exitCode: number | null = null;
    let errorMsg = "";

    process.exit = ((code: number) => {
      exitCode = code;
    }) as any;

    console.error = ((msg: string) => {
      errorMsg = msg;
    }) as any;

    try {
      buildPromptFile({
        kind: "delegate",
        files: [],
        focus: "",
        task: "",
        gitScope: "none",
        noProject: true,
      });
    } catch {
      // ignore
    }

    expect(exitCode).toBe(1);
    expect(errorMsg).toContain("task");

    process.exit = originalExit;
    console.error = originalError;
  });

  it("should use related git scope by default", () => {
    // This test verifies the option signature accepts the default
    const promptPath = buildPromptFile({
      kind: "review",
      files: [],
      focus: "test",
      task: "",
      gitScope: "related", // explicitly set (would be default)
      noProject: true,
    });

    expect(existsSync(promptPath)).toBe(true);
  });

  it("should return a path with tmp dir structure", () => {
    const promptPath = buildPromptFile({
      kind: "review",
      files: [],
      focus: "",
      task: "",
      gitScope: "none",
      noProject: true,
    });

    expect(promptPath).toContain("/tmp/relay/");
  });
});
