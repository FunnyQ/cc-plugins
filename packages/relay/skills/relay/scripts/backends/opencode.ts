import type { Backend, InvokeOpts, LiveSpec, Mode } from "../types";

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
 *
 * Output: `--format json` streams JSONL (one event per line) — `step_start`,
 * `text`, `step_finish`. The actual answer lives in the `text` events; relay
 * extracts it with parseJsonl rather than scraping `--format default`, whose
 * stream interleaves the answer with TUI/progress noise. parseJsonl concatenates
 * every `text` part and never blocks on a terminal event (#26855-safe).
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

    // JSON gives a clean, structured stream we can extract the final answer from
    // (parseOutput → parseJsonl); --format default interleaves TUI/progress noise.
    argv.push("--format", "json");

    // Append prompt text (opencode has no --prompt-file flag)
    if (opts.promptText !== undefined) {
      argv.push(opts.promptText);
    }

    return { argv };
  },

  invokeLive(_mode: Mode, opts: InvokeOpts): LiveSpec {
    const argv: string[] = [];
    if (opts.model) argv.push("-m", opts.model);
    // opencode has no --dangerously-* flag; its YOLO equivalent is `--auto`
    // ("auto-approve permissions that are not explicitly denied"), accepted by
    // the interactive TUI too. Gate it on --dangerous so it matches codex/claude:
    // --dangerous = unattended, no --dangerous = prompts surface in the pane.
    if (opts.dangerous) argv.push("--auto");
    return { agentBin: "opencode", argv };
  },

  parseOutput(raw: string): string {
    // Extract the concatenated `text` parts from the JSONL stream.
    return parseJsonl(raw);
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
