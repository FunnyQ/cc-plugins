#!/usr/bin/env bun
/**
 * Thin wrapper around the `codex` CLI for autopilot's codex paths.
 *
 * Autopilot's codex dev engine and its closing cross-vendor review lens both
 * reduce to the same invocation — `codex exec -s <mode> -o <last> -` with the
 * prompt on stdin — so this script wraps both and removes the dependency on the
 * odin-codex *plugin* (only the `codex` CLI is needed; autopilot already
 * version-checks it). It also kills the temp-mining problem: codex's clean last
 * message is captured to an internal scratch file that we print and then delete,
 * so the calling agent has a single deterministic stdout to read and **nothing
 * left in /tmp to go spelunking through**.
 *
 *   delegate — codex writes code. `codex exec -s workspace-write`.
 *              Edits land directly in the working tree; we append a
 *              `git status --short` so the driver sees what changed (including
 *              newly-created files) without reading codex's transcript.
 *   review   — codex critiques the diff, read-only. `codex exec -s read-only`.
 *              Edits nothing; prints codex's findings.
 *
 * The prompt comes from `--prompt-file <path>` or, if omitted, stdin.
 *
 * Model: `--model` flag > `CODEX_MODEL` > the per-mode `DEFAULT_MODEL`. Pinned rather
 * than left to `~/.codex/config.toml`, so a flight's engine does not change under it
 * when the user retunes their own codex default between waves.
 *
 * Usage:
 *   bun codex-run.ts delegate [--prompt-file <path>] [--model <m>]   # < prompt also works
 *   bun codex-run.ts review   [--prompt-file <path>] [--model <m>]
 *
 * Exits 0 on success; non-zero on codex failure or a missing/unreachable CLI
 * (stderr starts with `CODEX UNREACHABLE` so the caller can surface it verbatim
 * — a missing cross-vendor pass must fail the task, never pass quietly).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flagValue } from "./lib/args";
import {
  NO_ASK_CONTRACT,
  printChangedFiles,
  readPrompt,
} from "./lib/harness-run";

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";

type Mode = "delegate" | "review";

// Split by mode so the cheap model writes and the strong one reviews — the same
// dev≠reviewer asymmetry autopilot already builds across vendors, applied within
// codex. A reviewer weaker than the author would rubber-stamp its own blind spots.
const DEFAULT_MODEL: Record<Mode, string> = {
  delegate: "gpt-5.6-sol",
  review: "gpt-6-astra",
};

function resolveModel(mode: Mode, args: string[]): string {
  // An empty CODEX_MODEL is treated as unset, not as a model named "": the test
  // harness and a `CODEX_MODEL= bun ...` invocation both clear it that way.
  return (
    flagValue(args, "--model") || process.env.CODEX_MODEL || DEFAULT_MODEL[mode]
  );
}

const MODE_ARGS: Record<Mode, string[]> = {
  // `codex exec` is already non-interactive (no approval prompts), so the sandbox
  // policy is the only flag needed. workspace-write lets codex edit the tree.
  delegate: ["-s", "workspace-write"],
  // read-only: the review lens records findings, it must not touch source.
  review: ["-s", "read-only"],
};

// Returns the process exit code. Never calls process.exit itself — so the
// caller's `finally` cleanup always runs (process.exit would skip it, leaking
// the scratch dir, which the real smoke test caught).
function run(
  mode: Mode,
  prompt: string,
  lastFile: string,
  model: string,
): number {
  if (!prompt.trim()) {
    process.stderr.write("Empty prompt — nothing to send to codex\n");
    return 2;
  }

  let proc: Bun.SyncSubprocess<"pipe", "pipe">;
  try {
    proc = Bun.spawnSync(
      [CODEX_BIN, "exec", ...MODE_ARGS[mode], "-m", model, "-o", lastFile, "-"],
      // RELAY_DELEGATED marks this an unattended delegate, so monitor's
      // decision-log hooks stay quiet. `codex exec` runs its session in-process
      // and does read this var — only codex's interactive TUI cannot, because
      // that path runs hooks on a daemon whose env froze at its start.
      {
        stdin: Buffer.from(NO_ASK_CONTRACT + prompt),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, RELAY_DELEGATED: "1" },
      },
    );
  } catch {
    // spawnSync throws (not a failed result) when the binary isn't on PATH.
    process.stderr.write(`CODEX UNREACHABLE: ${CODEX_BIN} not found\n`);
    return 1;
  }

  if (!proc.success) {
    const err = proc.stderr.toString().trim();
    process.stderr.write(`CODEX UNREACHABLE: ${err || "codex exec failed"}\n`);
    return proc.exitCode || 1;
  }

  const output = (() => {
    try {
      return readFileSync(lastFile, "utf-8");
    } catch {
      return proc.stdout.toString(); // fall back to raw stdout if -o produced nothing
    }
  })();
  process.stdout.write(output.trimEnd() + "\n");

  if (mode === "delegate") printChangedFiles();
  return 0;
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode !== "delegate" && mode !== "review") {
    process.stderr.write(
      "Usage: bun codex-run.ts <delegate|review> [--prompt-file <path>] [--model <m>]\n",
    );
    process.exit(2);
  }

  const model = resolveModel(mode, rest);
  const prompt = readPrompt(rest); // before mkdtemp so its error path can't leak scratch
  const scratch = mkdtempSync(join(tmpdir(), "codex-run-"));
  let code = 1;
  try {
    code = run(mode, prompt, join(scratch, "last.txt"), model);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(code);
}

export { DEFAULT_MODEL, type Mode };
