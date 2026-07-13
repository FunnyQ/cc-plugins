import { describe, it, expect } from "bun:test";
import { claudeBackend } from "./claude";

describe("claudeBackend", () => {
  describe("invokeLive", () => {
    it("launches the bare TUI (no -p) and maps model + dangerous", () => {
      const spec = claudeBackend.invokeLive!("delegate", {
        model: "opus",
        dangerous: true,
      });

      expect(spec).toEqual({
        agentBin: "claude",
        argv: ["--model", "opus", "--dangerously-skip-permissions"],
      });
    });

    it("passes no extra args by default", () => {
      expect(claudeBackend.invokeLive!("review", {})).toEqual({
        agentBin: "claude",
        argv: [],
      });
    });
  });

  describe("properties", () => {
    it("has name 'claude'", () => {
      expect(claudeBackend.name).toBe("claude");
    });

    it("supports delegate and review only", () => {
      expect(claudeBackend.supports.has("delegate")).toBe(true);
      expect(claudeBackend.supports.has("review")).toBe(true);
      expect(claudeBackend.supports.has("image")).toBe(false);
    });
  });

  describe("strategy", () => {
    it("returns 'prompt' for delegate", () => {
      expect(claudeBackend.strategy("delegate")).toBe("prompt");
    });

    it("returns 'prompt' for review", () => {
      expect(claudeBackend.strategy("review", {})).toBe("prompt");
    });
  });

  describe("invoke", () => {
    describe("delegate mode", () => {
      it("builds argv with prompt text and json output format", () => {
        const result = claudeBackend.invoke("delegate", {
          promptText: "Test prompt",
        });
        expect(result.argv).toEqual([
          "claude",
          "-p",
          "Test prompt",
          "--output-format",
          "json",
        ]);
      });

      it("handles empty prompt text", () => {
        const result = claudeBackend.invoke("delegate", {
          promptText: "",
        });
        expect(result.argv).toEqual([
          "claude",
          "-p",
          "",
          "--output-format",
          "json",
        ]);
      });

      it("handles undefined prompt text", () => {
        const result = claudeBackend.invoke("delegate", {});
        expect(result.argv).toEqual([
          "claude",
          "-p",
          "",
          "--output-format",
          "json",
        ]);
      });
    });

    describe("review mode", () => {
      it("uses the generated review prompt instead of /code-review", () => {
        const result = claudeBackend.invoke("review", {
          promptText: "Analyze only. User request: review auth.ts",
        });
        expect(result.argv).toEqual([
          "claude",
          "-p",
          "Analyze only. User request: review auth.ts",
          "--output-format",
          "json",
        ]);
        expect(result.argv.join(" ")).not.toContain("/code-review");
      });
    });
  });

  describe("parseOutput", () => {
    describe("valid JSON with .result field (delegate response)", () => {
      it("extracts .result field", () => {
        const json = JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Implementation complete",
          session_id: "abc123",
          total_cost_usd: 0.01,
        });
        const output = claudeBackend.parseOutput(json);
        expect(output).toBe("Implementation complete");
      });
    });

    describe("JSON array of stream events (real --output-format json)", () => {
      it("extracts .result from the final result event", () => {
        const json = JSON.stringify([
          { type: "system", subtype: "init" },
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "relay works" }] },
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "relay works",
          },
        ]);
        const output = claudeBackend.parseOutput(json);
        expect(output).toBe("relay works");
      });

      it("falls back to raw when the array has no result event", () => {
        const json = JSON.stringify([
          { type: "system" },
          { type: "assistant" },
        ]);
        const output = claudeBackend.parseOutput(json);
        expect(output).toBe(json);
      });
    });

    describe("JSON with .text field (fallback)", () => {
      it("extracts .text when .result is absent", () => {
        const json = JSON.stringify({
          type: "response",
          text: "Response text",
        });
        const output = claudeBackend.parseOutput(json);
        expect(output).toBe("Response text");
      });
    });

    describe("JSON with .content[0].text field (fallback)", () => {
      it("extracts .content[0].text when result/text are absent", () => {
        const json = JSON.stringify({
          type: "response",
          content: [{ text: "Nested response" }],
        });
        const output = claudeBackend.parseOutput(json);
        expect(output).toBe("Nested response");
      });

      it("falls back to raw when .content is empty", () => {
        const json = JSON.stringify({
          type: "response",
          content: [],
        });
        const output = claudeBackend.parseOutput(json);
        // When content array is empty, falls back to raw JSON string trimmed
        expect(output).toBe('{"type":"response","content":[]}');
      });
    });

    describe("non-JSON input (review output)", () => {
      it("returns plain text when JSON.parse fails", () => {
        const plainText = "## Issues\n- Bug at line 42";
        const output = claudeBackend.parseOutput(plainText);
        expect(output).toBe("## Issues\n- Bug at line 42");
      });

      it("returns trimmed plain text", () => {
        const plainText = "   Some review feedback   ";
        const output = claudeBackend.parseOutput(plainText);
        expect(output).toBe("Some review feedback");
      });

      it("returns empty string for empty input", () => {
        const output = claudeBackend.parseOutput("");
        expect(output).toBe("");
      });

      it("returns trimmed whitespace-only input", () => {
        const output = claudeBackend.parseOutput("   ");
        expect(output).toBe("");
      });

      it("handles malformed JSON gracefully", () => {
        const malformed = "not json { broken";
        const output = claudeBackend.parseOutput(malformed);
        expect(output).toBe("not json { broken");
      });
    });

    describe("robustness", () => {
      it("never throws on any input", () => {
        const testCases = [
          "",
          "plain text",
          "{ invalid json",
          '{ "result": null }',
          '{ "result": 123 }',
        ];

        for (const input of testCases) {
          expect(() => claudeBackend.parseOutput(input)).not.toThrow();
        }
      });

      it("handles JSON primitives by falling back to raw", () => {
        expect(claudeBackend.parseOutput("null")).toBe("null");
        expect(claudeBackend.parseOutput("false")).toBe("false");
        expect(claudeBackend.parseOutput("true")).toBe("true");
      });

      it("prioritizes .result over .text", () => {
        const json = JSON.stringify({
          result: "primary",
          text: "secondary",
        });
        const output = claudeBackend.parseOutput(json);
        expect(output).toBe("primary");
      });

      it("prioritizes .text over .content[0].text", () => {
        const json = JSON.stringify({
          text: "primary",
          content: [{ text: "secondary" }],
        });
        const output = claudeBackend.parseOutput(json);
        expect(output).toBe("primary");
      });
    });
  });
});
