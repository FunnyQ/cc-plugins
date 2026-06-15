import type { Backend, InvokeOpts, Mode } from "../types";

/**
 * opencode Backend: delegate + emulated (prompt-based) review.
 *
 * Both modes use strategy = "prompt" (no native review).
 * Model defaults: delegate → opencode-go/kimi-k2.7-code, review → opencode-go/qwen3.7-max.
 * --model flag overrides the defaults.
 *
 * Limitations:
 * - Review is prompt-based only: "Analyze only — do not modify files" is in the prompt text.
 *   Hard read-only via --agent is deferred.
 * - Output parsing tolerates bug #26855 (--format json can exit before emitting step_finish).
 */
export const opencodeBackend: Backend = {
  name: "opencode",
  supports: new Set(["delegate", "review"]),

  strategy() {
    return "prompt";
  },

  invoke(_mode: Mode, opts: InvokeOpts) {
    // Model is already resolved in relay.ts (flag > config > per-mode default);
    // opts.model is the final value — do not re-resolve here.
    const model = opts.model;
    const argv: string[] = ["opencode", "run"];

    // Add resolved model (or default)
    if (model) {
      argv.push("-m", model);
    }

    // v1: use --format default (simplest; avoids JSON parsing complexity + #26855)
    argv.push("--format", "default");

    // Append prompt text (opencode has no --prompt-file flag)
    if (opts.promptText !== undefined) {
      argv.push(opts.promptText);
    }

    return { argv };
  },

  parseOutput(raw: string): string {
    // For --format default, just trim the output
    return raw.trim();
  },
};

/**
 * Parse JSONL output from opencode when --format json is used.
 *
 * Extracts all `.part.text` from lines where `.type === "text"`.
 * Ignores malformed lines and does NOT require a terminal step_finish event (bug #26855).
 *
 * @param raw - Raw JSONL text (one JSON object per line)
 * @returns Concatenated text from all text parts
 */
export function parseJsonl(raw: string): string {
  const lines = raw.split("\n");
  const textParts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === "text" && obj.part?.text) {
        textParts.push(obj.part.text);
      }
    } catch {
      // Ignore malformed lines silently
      continue;
    }
  }

  return textParts.join("");
}
