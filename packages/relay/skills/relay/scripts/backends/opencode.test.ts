import { describe, it, expect } from "bun:test";
import { opencodeBackend, parseJsonl } from "./opencode";
import type { InvokeOpts } from "../types";

describe("opencodeBackend", () => {
  describe("invokeLive", () => {
    it("launches the bare TUI with the resolved model", () => {
      const spec = opencodeBackend.invokeLive!("delegate", {
        model: "opencode-go/kimi-k2.7-code",
      });

      expect(spec).toEqual({
        agentBin: "opencode",
        argv: ["-m", "opencode-go/kimi-k2.7-code"],
      });
    });

    it("maps --dangerous to --auto (opencode's YOLO), never headless flags", () => {
      const spec = opencodeBackend.invokeLive!("delegate", {
        dangerous: true,
      })!;

      expect(spec.argv).toEqual(["--auto"]);
      expect(spec.argv).not.toContain("run");
      expect(spec.argv).not.toContain("--format");
    });

    it("omits --auto without --dangerous (prompts surface in the pane)", () => {
      const spec = opencodeBackend.invokeLive!("delegate", {})!;

      expect(spec.argv).toEqual([]);
    });
  });

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
    // relay.ts resolves the model (flag > config > per-mode default) and passes
    // it as opts.model; invoke trusts that value. These pass the resolved model
    // the way relay.ts would.
    it("builds delegate argv with the resolved model", () => {
      const opts: InvokeOpts = {
        promptText: "test prompt",
        model: "opencode-go/kimi-k2.7-code",
      };
      const result = opencodeBackend.invoke("delegate", opts);

      expect(result.argv).toEqual([
        "opencode",
        "run",
        "-m",
        "opencode-go/kimi-k2.7-code",
        "--format",
        "json",
        "test prompt",
      ]);
    });

    it("builds review argv with the resolved model", () => {
      const opts: InvokeOpts = {
        promptText: "review prompt",
        model: "opencode-go/qwen3.7-max",
      };
      const result = opencodeBackend.invoke("review", opts);

      expect(result.argv).toEqual([
        "opencode",
        "run",
        "-m",
        "opencode-go/qwen3.7-max",
        "--format",
        "json",
        "review prompt",
      ]);
    });

    it("omits -m when no model was resolved", () => {
      const opts: InvokeOpts = { promptText: "test prompt" };
      const result = opencodeBackend.invoke("delegate", opts);

      expect(result.argv).toEqual([
        "opencode",
        "run",
        "--format",
        "json",
        "test prompt",
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
      expect(result.argv).toContain("json");
      expect(result.argv).toContain("");
    });

    it("handles missing prompt text", () => {
      const opts: InvokeOpts = { model: "opencode-go/kimi-k2.7-code" };
      const result = opencodeBackend.invoke("delegate", opts);

      // Should build argv without appending undefined
      expect(result.argv).toEqual([
        "opencode",
        "run",
        "-m",
        "opencode-go/kimi-k2.7-code",
        "--format",
        "json",
      ]);
    });
  });

  describe("parseOutput", () => {
    // parseOutput delegates to parseJsonl — extract `text` parts from the JSONL
    // stream. (parseJsonl itself is exhaustively tested in its own describe block.)
    it("extracts the answer from a real opencode JSONL stream", () => {
      const raw = [
        '{"type":"step_start","part":{"type":"step-start"}}',
        '{"type":"text","part":{"type":"text","text":"hello world"}}',
        '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}',
      ].join("\n");
      const result = opencodeBackend.parseOutput(raw);
      expect(result).toBe("hello world");
    });

    it("returns empty string for non-JSONL output", () => {
      const result = opencodeBackend.parseOutput("not json at all");
      expect(result).toBe("");
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
