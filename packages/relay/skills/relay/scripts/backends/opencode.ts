import type { Backend, InvokeOpts, LiveSpec, Mode } from "../types";

/**
 * No model is pinned: hosted ids churn, and a pinned default rotted once already.
 *
 * Verified against opencode 2.2.6. The 2.x TUI takes no `-m`, so a run with a
 * model always goes headless (see invokeLive).
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
 * stream interleaves the answer with TUI/progress noise.
 */
export const opencodeBackend: Backend = {
  name: "opencode",
  supports: new Set(["delegate", "review"]),

  invoke(mode: Mode, opts: InvokeOpts) {
    const model = opts.model;
    const argv: string[] = ["opencode", "run"];

    if (model) {
      argv.push("-m", model);
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

    // The prompt rides stdin: npm's opencode.cmd shim makes Bun refuse any
    // argument holding `"`, `%`, `&` or a newline on Windows.
    return { argv, stdin: opts.promptText };
  },

  invokeLive(_mode: Mode, opts: InvokeOpts): LiveSpec | null {
    // The 2.x TUI exits on `-m` ("Unrecognized flag"), and OPENCODE_CONFIG_CONTENT
    // never reaches the background service that resolves the model (2.2.6), so a
    // chosen model has no live path; relay.ts then runs it headless.
    if (opts.model) return null;
    const argv: string[] = [];
    // `--auto` is accepted by the TUI too. Gate it on --dangerous so it matches
    // codex/claude: --dangerous = unattended, no --dangerous = prompts surface
    // in the pane.
    if (opts.dangerous) argv.push("--auto");
    return { agentBin: "opencode", argv };
  },

  parseOutput(raw: string): string {
    return parseJsonl(raw);
  },

  parseError,
};

/** Ignores malformed lines and does NOT require a terminal step_finish event (bug #26855). */
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
      continue;
    }
  }

  return textParts.join("");
}

/**
 * `opencode run` exits 1 with empty stderr and reports the cause only as a
 * JSONL event on stdout: 2.x {"type":"error","error":{"type":..,"message":..}},
 * 1.x {"type":"error","error":{"name":..,"data":{"message":..}}}.
 */
export function parseError(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    try {
      const obj = JSON.parse(line.trim());
      if (obj.type === "error") {
        const e = obj.error;
        return (
          e?.message || e?.data?.message || e?.type || e?.name || undefined
        );
      }
    } catch {
      continue;
    }
  }
  return undefined;
}
