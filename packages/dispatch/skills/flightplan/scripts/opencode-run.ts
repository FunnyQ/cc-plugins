#!/usr/bin/env bun
/**
 * Thin wrapper around the `opencode` CLI for autopilot's opencode paths.
 *
 * Mirrors `codex-run.ts`: autopilot's opencode dev engine and its closing
 * cross-vendor review lens both reduce to `opencode run -m <model> --format json
 * "<prompt>"`, so this wraps both and keeps only the `opencode` CLI as a
 * dependency (autopilot version-checks it). opencode prints a JSONL event stream
 * on stdout; we extract the answer with `parseJsonl` (the `text` parts) rather
 * than scraping `--format default`, whose stream interleaves the answer with TUI
 * progress noise.
 *
 *   delegate — opencode writes code (write-capable by default). We append a
 *              `git status --short` so the driver sees what changed (including
 *              newly-created files) without mining opencode's transcript.
 *   review   — opencode has NO sandboxed read-only mode (there is no equivalent
 *              of codex's `-s read-only` yet), so review is PROMPT-ENFORCED: we
 *              prepend a hard "analyze only, do not modify any file" guard to the
 *              prompt. This is weaker than codex's sandbox guarantee — a
 *              documented tradeoff; the Final review fixer is the only step that
 *              edits, and it re-runs verification afterwards.
 *
 * Model (opencode requires `-m provider/model`): `--model` flag > `OPENCODE_MODEL`
 * env > per-mode default (delegate `opencode-go/kimi-k2.7-code`, review
 * `opencode-go/qwen3.7-max` — the same defaults as the relay opencode backend).
 *
 * The prompt comes from `--prompt-file <path>` or, if omitted, stdin — the same
 * caller interface as `codex-run.ts`, even though opencode takes the prompt as an
 * argv positional (not stdin).
 *
 * Usage:
 *   bun opencode-run.ts delegate [--prompt-file <path>] [--model <m>]
 *   bun opencode-run.ts review   [--prompt-file <path>] [--model <m>]
 *
 * Exits 0 on success; non-zero on failure or a missing/unreachable CLI (stderr
 * starts with `OPENCODE UNREACHABLE` so the caller can surface it verbatim — a
 * missing cross-vendor pass must fail the task, never pass quietly).
 */
import { readFileSync } from "node:fs";

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode";

type Mode = "delegate" | "review";

const DEFAULT_MODEL: Record<Mode, string> = {
  delegate: "opencode-go/kimi-k2.7-code",
  review: "opencode-go/qwen3.7-max",
};

// Prepended to the prompt in review mode. opencode can't enforce read-only at the
// sandbox level, so this guard is the only thing keeping the review lens from
// editing the tree — keep it loud and unambiguous.
const REVIEW_GUARD =
  "READ-ONLY REVIEW. Analyze only — do NOT modify, create, or delete any file, " +
  "and do not run any command that writes to disk. Report findings only.\n\n";

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v) {
    process.stderr.write(`Missing value after ${name}\n`);
    process.exit(2);
  }
  return v;
}

function readPrompt(args: string[]): string {
  const path = flagValue(args, "--prompt-file");
  if (path) return readFileSync(path, "utf-8");
  return readFileSync(0, "utf-8"); // stdin
}

function resolveModel(mode: Mode, args: string[]): string {
  return (
    flagValue(args, "--model") ??
    process.env.OPENCODE_MODEL ??
    DEFAULT_MODEL[mode]
  );
}

/**
 * Extract the concatenated `text` parts from opencode's `--format json` (JSONL)
 * stream. Ignores malformed lines and never blocks on a terminal `step_finish`
 * event (opencode bug #26855: `--format json` can exit before emitting it).
 * Self-contained copy of relay's opencode parser — no cross-plugin import.
 */
export function parseJsonl(raw: string): string {
  const textParts: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === "text" && obj.part?.text) textParts.push(obj.part.text);
    } catch {
      // Ignore malformed lines silently.
      continue;
    }
  }
  return textParts.join("");
}

// Returns the process exit code. Never calls process.exit itself — so any caller
// wrapping this stays in control of teardown (mirrors codex-run's contract).
function run(mode: Mode, prompt: string, model: string): number {
  if (!prompt.trim()) {
    process.stderr.write("Empty prompt — nothing to send to opencode\n");
    return 2;
  }

  const message = mode === "review" ? REVIEW_GUARD + prompt : prompt;

  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(
      [OPENCODE_BIN, "run", "-m", model, "--format", "json", message],
      // stdin "ignore": opencode inherits stdin and hangs if it stays open with no
      // EOF; closing it makes `run` return normally (see relay's backends note).
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
  } catch {
    // spawnSync throws (not a failed result) when the binary isn't on PATH.
    process.stderr.write(`OPENCODE UNREACHABLE: ${OPENCODE_BIN} not found\n`);
    return 1;
  }

  if (!proc.success) {
    const err = proc.stderr.toString().trim();
    process.stderr.write(
      `OPENCODE UNREACHABLE: ${err || "opencode run failed"}\n`,
    );
    return proc.exitCode || 1;
  }

  const output = parseJsonl(proc.stdout.toString());
  process.stdout.write(output.trimEnd() + "\n");

  if (mode === "delegate") {
    // Show what landed in the working tree, so the driver never needs to read
    // opencode's transcript. `git status --short` (not `git diff`) so NEWLY-
    // created files show up too — `git diff` ignores untracked paths.
    const st = Bun.spawnSync(["git", "status", "--short"], { stdout: "pipe" });
    const changed = st.stdout.toString().trim();
    process.stdout.write(
      `\n--- changed files (git status --short) ---\n${changed || "(no working-tree changes detected)"}\n`,
    );
  }
  return 0;
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode !== "delegate" && mode !== "review") {
    process.stderr.write(
      "Usage: bun opencode-run.ts <delegate|review> [--prompt-file <path>] [--model <m>]\n",
    );
    process.exit(2);
  }

  const prompt = readPrompt(rest);
  const model = resolveModel(mode, rest);
  process.exit(run(mode, prompt, model));
}

export { DEFAULT_MODEL, REVIEW_GUARD, type Mode };
