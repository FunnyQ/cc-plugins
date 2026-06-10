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
 *   delegate — codex writes code. `codex exec -s workspace-write -a never`.
 *              Edits land directly in the working tree; we append a
 *              `git diff --stat` so the driver sees what changed without reading
 *              codex's transcript.
 *   review   — codex critiques the diff, read-only. `codex exec -s read-only`.
 *              Edits nothing; prints codex's findings.
 *
 * The prompt comes from `--prompt-file <path>` or, if omitted, stdin.
 *
 * Usage:
 *   bun codex-run.ts delegate [--prompt-file <path>]   # < prompt also works
 *   bun codex-run.ts review   [--prompt-file <path>]
 *
 * Exits 0 on success; non-zero on codex failure or a missing/unreachable CLI
 * (stderr starts with `CODEX UNREACHABLE` so the caller can surface it verbatim
 * — a missing cross-vendor pass must fail the task, never pass quietly).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";

type Mode = "delegate" | "review";

const MODE_ARGS: Record<Mode, string[]> = {
  // `codex exec` is already non-interactive (no approval prompts), so the sandbox
  // policy is the only flag needed. workspace-write lets codex edit the tree.
  delegate: ["-s", "workspace-write"],
  // read-only: the review lens records findings, it must not touch source.
  review: ["-s", "read-only"],
};

function readPrompt(args: string[]): string {
  const i = args.indexOf("--prompt-file");
  if (i !== -1) {
    const path = args[i + 1];
    if (!path) {
      process.stderr.write("Missing path after --prompt-file\n");
      process.exit(2);
    }
    return readFileSync(path, "utf-8");
  }
  return readFileSync(0, "utf-8"); // stdin
}

// Returns the process exit code. Never calls process.exit itself — so the
// caller's `finally` cleanup always runs (process.exit would skip it, leaking
// the scratch dir, which the real smoke test caught).
function run(mode: Mode, prompt: string, lastFile: string): number {
  if (!prompt.trim()) {
    process.stderr.write("Empty prompt — nothing to send to codex\n");
    return 2;
  }

  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(
      [CODEX_BIN, "exec", ...MODE_ARGS[mode], "-o", lastFile, "-"],
      { stdin: Buffer.from(prompt), stdout: "pipe", stderr: "pipe" },
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

  if (mode === "delegate") {
    // Show what landed in the working tree, so the driver never needs to read
    // codex's transcript to learn what it changed. `git status --short` (not
    // `git diff`) so NEWLY-created files show up too — `git diff` ignores
    // untracked paths, which would hide the common "codex created a file" case.
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
      "Usage: bun codex-run.ts <delegate|review> [--prompt-file <path>]\n",
    );
    process.exit(2);
  }

  const prompt = readPrompt(rest); // before mkdtemp so its error path can't leak scratch
  const scratch = mkdtempSync(join(tmpdir(), "codex-run-"));
  let code = 1;
  try {
    code = run(mode, prompt, join(scratch, "last.txt"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(code);
}

export { MODE_ARGS, type Mode };
