import { describe, it, expect } from "bun:test";
import { opencodeBackend, parseJsonl } from "./opencode";
import type { InvokeOpts } from "../types";

describe("opencodeBackend", () => {
  describe("supports", () => {
    it("supports delegate and review", () => {
      expect(opencodeBackend.supports.has("delegate")).toBe(true);
      expect(opencodeBackend.supports.has("review")).toBe(true);
      expect(opencodeBackend.supports.has("image")).toBe(false);
    });
  });

  describe("strategy", () => {
    it("always returns 'prompt'", () => {
      expect(opencodeBackend.strategy("delegate", {} as InvokeOpts)).toBe(
        "prompt",
      );
      expect(opencodeBackend.strategy("review", {} as InvokeOpts)).toBe(
        "prompt",
      );
    });
  });

  describe("invoke", () => {
    it("builds delegate argv with kimi model by default", () => {
      const opts: InvokeOpts = { promptText: "test prompt" };
      const result = opencodeBackend.invoke("delegate", opts);

      expect(result.argv).toEqual([
        "opencode",
        "run",
        "-m",
        "opencode-go/kimi-k2.7-code",
        "--format",
        "default",
        "test prompt",
      ]);
    });

    it("builds review argv with qwen model by default", () => {
      const opts: InvokeOpts = { promptText: "review prompt" };
      const result = opencodeBackend.invoke("review", opts);

      expect(result.argv).toEqual([
        "opencode",
        "run",
        "-m",
        "opencode-go/qwen3.7-max",
        "--format",
        "default",
        "review prompt",
      ]);
    });

    it("overrides model with --model flag", () => {
      const opts: InvokeOpts = {
        promptText: "test",
        model: "opencode-go/custom-model",
      };
      const result = opencodeBackend.invoke("delegate", opts);

      expect(result.argv).toContain("-m");
      expect(result.argv).toContain("opencode-go/custom-model");
    });

    it("handles empty prompt text", () => {
      const opts: InvokeOpts = { promptText: "" };
      const result = opencodeBackend.invoke("delegate", opts);

      // Should still build argv, just with empty prompt
      expect(result.argv).toContain("--format");
      expect(result.argv).toContain("default");
      expect(result.argv).toContain("");
    });

    it("handles missing prompt text", () => {
      const opts: InvokeOpts = {};
      const result = opencodeBackend.invoke("delegate", opts);

      // Should build argv without appending undefined
      expect(result.argv).toEqual([
        "opencode",
        "run",
        "-m",
        "opencode-go/kimi-k2.7-code",
        "--format",
        "default",
      ]);
    });
  });

  describe("parseOutput", () => {
    it("trims whitespace from formatted output", () => {
      const raw = "  formatted output text  \n\n";
      const result = opencodeBackend.parseOutput(raw);
      expect(result).toBe("formatted output text");
    });

    it("preserves internal whitespace", () => {
      const raw = "  line 1\n  line 2  ";
      const result = opencodeBackend.parseOutput(raw);
      expect(result).toBe("line 1\n  line 2");
    });
  });
});

describe("parseJsonl", () => {
  it("extracts text from JSONL with single text part", () => {
    const jsonl = '{"type":"text","part":{"text":"Hello"}}';
    const result = parseJsonl(jsonl);
    expect(result).toBe("Hello");
  });

  it("concatenates multiple text parts", () => {
    const jsonl = [
      '{"type":"text","part":{"text":"Hello"}}',
      '{"type":"status","status":"running"}',
      '{"type":"text","part":{"text":" world"}}',
    ].join("\n");
    const result = parseJsonl(jsonl);
    expect(result).toBe("Hello world");
  });

  it("ignores non-text lines", () => {
    const jsonl = [
      '{"type":"start"}',
      '{"type":"text","part":{"text":"Content"}}',
      '{"type":"status","code":0}',
    ].join("\n");
    const result = parseJsonl(jsonl);
    expect(result).toBe("Content");
  });

  it("ignores malformed JSON lines silently", () => {
    const jsonl = [
      '{"type":"text","part":{"text":"First"}}',
      "this is not json",
      '{"type":"text","part":{"text":"Second"}}',
    ].join("\n");
    const result = parseJsonl(jsonl);
    expect(result).toBe("FirstSecond");
  });

  it("handles missing step_finish event (bug #26855)", () => {
    // No terminal step_finish; should still work
    const jsonl = [
      '{"type":"text","part":{"text":"Result"}}',
      '{"type":"status","status":"complete"}',
    ].join("\n");
    const result = parseJsonl(jsonl);
    expect(result).toBe("Result");
  });

  it("handles empty input", () => {
    const result = parseJsonl("");
    expect(result).toBe("");
  });

  it("handles lines with only whitespace", () => {
    const jsonl = [
      '{"type":"text","part":{"text":"Text"}}',
      "   ",
      '{"type":"text","part":{"text":"More"}}',
    ].join("\n");
    const result = parseJsonl(jsonl);
    expect(result).toBe("TextMore");
  });

  it("handles objects with missing part.text", () => {
    const jsonl = [
      '{"type":"text","part":{}}',
      '{"type":"text","part":{"text":"Valid"}}',
    ].join("\n");
    const result = parseJsonl(jsonl);
    expect(result).toBe("Valid");
  });

  it("handles objects with missing part object", () => {
    const jsonl = [
      '{"type":"text"}',
      '{"type":"text","part":{"text":"Valid"}}',
    ].join("\n");
    const result = parseJsonl(jsonl);
    expect(result).toBe("Valid");
  });
});
