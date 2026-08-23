/**
 * The pieces codex-run.ts and opencode-run.ts genuinely share.
 *
 * Deliberately only two functions. The spawn shape, the output extraction, and
 * how read-only is enforced differ per harness (codex has a `-s read-only`
 * sandbox, opencode only has a prompt guard) — folding those together would
 * turn a real capability difference into a conditional. What is shared is the
 * prompt source and the changed-files report, and the concrete failure that
 * prevents is a fix to the report format landing on one driver but not the
 * other.
 */
import { readFileSync } from "node:fs";
import { flagValue } from "./args";

/** The prompt: `--prompt-file <path>` when given, otherwise stdin. */
export function readPrompt(args: string[]): string {
  const path = flagValue(args, "--prompt-file");
  if (path) return readFileSync(path, "utf-8");
  return readFileSync(0, "utf-8"); // stdin
}

/**
 * Print what landed in the working tree, so the driver never needs to read the
 * harness transcript to learn what it changed. `git status --short` (not
 * `git diff`) so NEWLY-created files show up too — `git diff` ignores untracked
 * paths, which would hide the common "the harness created a file" case.
 */
export function printChangedFiles(): void {
  const st = Bun.spawnSync(["git", "status", "--short"], { stdout: "pipe" });
  const changed = st.stdout.toString().trim();
  process.stdout.write(
    `\n--- changed files (git status --short) ---\n${changed || "(no working-tree changes detected)"}\n`,
  );
}
