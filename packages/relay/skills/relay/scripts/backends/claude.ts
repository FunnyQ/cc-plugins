import type { Backend, InvokeOpts, LiveSpec, Mode } from "../types";

export const claudeBackend: Backend = {
  name: "claude",
  supports: new Set(["delegate", "review"]),

  strategy(_mode: Mode) {
    return "prompt";
  },

  invoke(mode: Mode, opts: InvokeOpts) {
    if (mode === "delegate" || mode === "review") {
      // Both modes use the prompt text that relay.ts has already built.
      // Always use --output-format json to get a structured envelope.
      return {
        argv: [
          "claude",
          "-p",
          opts.promptText || "",
          "--output-format",
          "json",
        ],
      };
    }

    // Should not reach here (gate prevents unsupported modes), but be defensive
    return { argv: [] };
  },

  invokeLive(_mode: Mode, opts: InvokeOpts): LiveSpec {
    const argv: string[] = [];
    if (opts.model) argv.push("--model", opts.model);
    if (opts.dangerous) argv.push("--dangerously-skip-permissions");
    return { agentBin: "claude", argv };
  },

  parseOutput(raw: string): string {
    // Try to parse as JSON. If it fails (delegate mode outputs JSON, review outputs plain text),
    // gracefully fall back to raw.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not JSON — return raw text.
      return raw.trim();
    }

    // `claude -p --output-format json` returns an ARRAY of stream events
    // ([{type:"system"…}, {type:"assistant"…}, {type:"result", result:"…"}]).
    // The final `result` event carries the answer — extract it rather than
    // dumping the whole stream.
    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        const event = parsed[i];
        if (
          event &&
          typeof event === "object" &&
          (event as Record<string, unknown>).type === "result" &&
          typeof (event as Record<string, unknown>).result === "string"
        ) {
          return (event as Record<string, unknown>).result as string;
        }
      }
      return raw.trim();
    }

    // Only plain objects carry an extractable envelope; anything else is raw.
    if (typeof parsed !== "object" || parsed === null) {
      return raw.trim();
    }
    const obj = parsed as Record<string, unknown>;

    // Extraction order: .result → .text → .content[0].text → raw
    if (typeof obj.result === "string") {
      return obj.result;
    }

    if (typeof obj.text === "string") {
      return obj.text;
    }

    // Try .content[0].text, but only if content is a non-empty array of objects.
    if (
      Array.isArray(obj.content) &&
      obj.content.length > 0 &&
      typeof obj.content[0] === "object" &&
      obj.content[0] !== null
    ) {
      const first = obj.content[0] as Record<string, unknown>;
      if (typeof first.text === "string") {
        return first.text;
      }
    }

    // Fallback: return raw text trimmed.
    return raw.trim();
  },
};
