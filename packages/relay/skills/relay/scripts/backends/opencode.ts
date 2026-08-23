import type { Backend, InvokeOpts, LiveSpec, Mode } from "../types";

/**
 * opencode Backend: delegate + emulated (prompt-based) review.
 *
 * Both modes run off relay's built prompt (no native review).
 * Model defaults: delegate → opencode-go/deepseek-v4-light; review → opencode-go/deepseek-v4-pro.
 * Delegate uses the max reasoning variant.
 * --model flag overrides the defaults.
 *
 * Permissions: `--dangerous` maps to `--auto` on BOTH paths (headless invoke
 * and live TUI). Headless `run` auto-REJECTS approval prompts when `--auto` is
 * absent — no pane means no human can answer — so a non-dangerous headless
 * delegate silently loses approval-gated operations. `--auto` auto-approves
 * only what is not explicitly denied: explicit deny rules still block, so it is
 * not a full bypass like codex's --dangerously-bypass-approvals-and-sandbox.
 *
 * Limitations:
 * - Review is prompt-based only: "Analyze only — do not modify files" is in the prompt text.
 *   Hard read-only via a `--agent` profile with edit/bash denied is possible
 *   but not wired in — the profile would have to exist in every machine's
 *   opencode config.
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

  invoke(mode: Mode, opts: InvokeOpts) {
    // Model is already resolved in relay.ts (flag > config > per-mode default);
    // opts.model is the final value — do not re-resolve here.
    const model = opts.model;
    const argv: string[] = ["opencode", "run"];

    // Add resolved model (or default)
    if (model) {
      argv.push("-m", model);
    }
    if (mode === "delegate") {
      argv.push("--variant", "max");
    }

    // JSON gives a clean, structured stream we can extract the final answer from
    // (parseOutput → parseJsonl); --format default interleaves TUI/progress noise.
    argv.push("--format", "json");

    // Headless run auto-REJECTS permission requests (no pane, no human to ask),
    // so --auto is the only way an unattended delegate gets past approval
    // prompts. Same mapping as the live path, keeping --dangerous uniform
    // across headless/live (matches codex/claude headless behavior).
    if (opts.dangerous) {
      argv.push("--auto");
    }

    // Append prompt text (opencode has no --prompt-file flag). The `--` stops
    // yargs from parsing flag-like tokens inside the task (e.g. "add --help
    // flag") as options — run.ts merges args["--"] back into the message.
    if (opts.promptText !== undefined) {
      argv.push("--", opts.promptText);
    }

    return { argv };
  },

  invokeLive(mode: Mode, opts: InvokeOpts): LiveSpec {
    const argv: string[] = [];
    if (opts.model) argv.push("-m", opts.model);
    if (mode === "delegate") argv.push("--variant", "max");
    // opencode's approval-bypass flag is `--auto` ("auto-approve permissions
    // that are not explicitly denied (dangerous!)"), accepted by the interactive
    // TUI too. Hidden `--yolo` / `--dangerously-skip-permissions` aliases exist
    // on `run` and currently collapse to the same boolean (1.18.18) — not a
    // separate, stronger mode. Gate --auto on --dangerous so it matches
    // codex/claude: --dangerous = unattended, no --dangerous = prompts surface
    // in the pane. Note --auto still respects explicit deny rules — it is not a
    // full bypass like codex's flag.
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
