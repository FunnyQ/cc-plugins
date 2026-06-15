import type { Backend, InvokeOpts, Mode } from "../types";

// Effort levels supported by /code-review
const EFFORT_LEVELS = new Set(["low", "medium", "high", "ultra"]);

/**
 * Parse opts.focus to extract effort level and optional focus phrase.
 *
 * Rule: split focus by whitespace; if the first token is an effort level,
 * treat it as the effort and rejoin the rest as the focus phrase. Otherwise,
 * use default effort "high" and treat the whole focus as the focus phrase.
 * If focus is undefined, use default effort with no phrase.
 */
function parseEffortAndFocus(focus: string | undefined): {
  effort: string;
  phrase?: string;
} {
  if (!focus) {
    return { effort: "high" };
  }

  const tokens = focus.trim().split(/\s+/);
  const firstToken = tokens[0];
  if (EFFORT_LEVELS.has(firstToken)) {
    const effort = firstToken;
    const phrase = tokens.slice(1).join(" ");
    return { effort, phrase: phrase || undefined };
  }

  // First token is not an effort level; use default and treat whole focus as phrase
  return { effort: "high", phrase: focus };
}

export const claudeBackend: Backend = {
  name: "claude",
  supports: new Set(["delegate", "review"]),

  strategy(mode: Mode) {
    if (mode === "review") {
      return "native";
    }
    return "prompt";
  },

  invoke(mode: Mode, opts: InvokeOpts) {
    if (mode === "delegate") {
      // Delegate uses the prompt text that relay.ts has already read.
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

    if (mode === "review") {
      // Review uses the native /code-review command.
      // Parse effort and focus from opts.focus.
      const { effort, phrase } = parseEffortAndFocus(opts.focus);
      const reviewCmd = `/code-review ${effort}${phrase ? " " + phrase : ""}`;
      return {
        argv: ["claude", "-p", reviewCmd],
      };
    }

    // Should not reach here (gate prevents unsupported modes), but be defensive
    return { argv: [] };
  },

  parseOutput(raw: string): string {
    // Try to parse as JSON. If it fails (delegate mode outputs JSON, review outputs plain text),
    // gracefully fall back to raw.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not JSON (e.g., review mode output from /code-review) — return raw text.
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
