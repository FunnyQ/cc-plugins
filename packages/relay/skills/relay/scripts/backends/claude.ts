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
  if (tokens.length === 0) {
    return { effort: "high" };
  }

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

    // Extraction order: .result → .text → .content[0].text → raw
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).result === "string"
    ) {
      return (parsed as Record<string, unknown>).result as string;
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).text === "string"
    ) {
      return (parsed as Record<string, unknown>).text as string;
    }

    // Try .content[0].text, but only if parsed is a plain object with a content array.
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
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
    }

    // Fallback: return raw text trimmed.
    return raw.trim();
  },
};
