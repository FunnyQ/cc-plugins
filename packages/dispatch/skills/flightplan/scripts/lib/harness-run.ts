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

/**
 * Prepended to every prompt these wrappers run. Unconditional because autopilot is
 * their only caller and it is never watching; relay's `--no-ask` carries the same
 * words on the live path, which needs a flag because a human may be at that pane.
 *
 * It lives at this seam rather than in the instruction the driver writes, because
 * a driver asked to copy a rule can paraphrase it away — measured: the same driver
 * carried the no-commit and no-restore bans into two real instruction files and
 * dropped this one from both.
 */
export const NO_ASK_CONTRACT =
  "Nobody is watching this run, so do not call any ask, clarify, or " +
  "request-user-input tool, and never wait on a reply to one. Where the request " +
  "is ambiguous, do exactly what it specifies. Where something genuinely blocks " +
  "you, never substitute your own scope, framework, or gate to get past it — " +
  "finish what you can, then name the blocker in your final answer.\n\n";

/**
 * The prompt: `--prompt-file <path>` when given, otherwise stdin.
 *
 * Returns the caller's text alone. Each wrapper prepends the contract at the spawn
 * instead, after its empty-prompt guard: prepending here makes every prompt
 * non-empty, so "nothing to send" becomes a billed call on boilerplate.
 */
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
