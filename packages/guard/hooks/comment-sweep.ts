#!/usr/bin/env bun
/**
 * Turn-level companion to comment-guard: catches the comment blocks a turn
 * wrote without Edit or Write — `sed -i`, a heredoc, a codegen script — which
 * no PostToolUse Edit|Write hook ever sees.
 *
 *   snapshot  (UserPromptSubmit) stores the worktree as a git tree object.
 *   sweep     (Stop) diffs the worktree against it and hands back every block
 *             the turn added or grew, as a Stop `decision: block`.
 *
 * The tree is written through a throwaway index, so untracked files are
 * included while the worktree and the real index stay untouched. The diff runs
 * through comment-guard's own `resolveAdded` and `flaggedBlocks`, so the two
 * hooks agree on every rule: re-indenting is not an addition, blocks under
 * three lines stay quiet, the file header is exempt.
 *
 * Output: silent unless a reportable block exists. Always exits 0.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flaggedBlocks,
  formatReason,
  isGuardedPath,
  resolveAdded,
  syntaxFor,
  type Hunk,
} from "./comment-guard.ts";
import {
  clearBaseline,
  clearReported,
  readBaseline,
  readReported,
  writeBaseline,
} from "./sweep-state.ts";

// A checkout, pull or formatter run rewrites files nobody in this turn authored; past this many, the report would be noise.
const MAX_FILES = 20;

type Payload = { session_id?: string; cwd?: string };

function git(
  root: string,
  args: string[],
  env?: Record<string, string>,
): string | null {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

function worktreeTree(root: string): string | null {
  const scratch = mkdtempSync(join(tmpdir(), "comment-sweep-"));
  const index = join(scratch, "index");
  try {
    // Seeding from the real index lets `add -A` skip rehashing every unchanged tracked file.
    const real = git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ])?.trim();
    if (real && existsSync(real)) copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index };
    if (git(root, ["add", "-A"], env) === null) return null;
    return git(root, ["write-tree"], env)?.trim() || null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `git diff -U0` hunks in the shape comment-guard reads off `structuredPatch`. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of diff.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { newStart: Number(header[1]), lines: [] };
      hunks.push(current);
    } else if (current && /^[+\-\\]/.test(line)) {
      current.lines!.push(line);
    }
  }
  return hunks;
}

// The Edit hook already put these lines to the model this turn; asking again would repeat the question it answered.
function withoutReported(
  added: Set<number> | string[],
  lines: string[],
  seen: Map<string, number> | undefined,
): Set<number> | string[] {
  if (!seen) return added;
  const fresh = (text: string) => {
    const left = seen.get(text) ?? 0;
    if (left > 0) seen.set(text, left - 1);
    return left === 0;
  };
  if (Array.isArray(added)) return added.filter(fresh);
  return new Set(
    [...added].sort((a, b) => a - b).filter((n) => fresh(lines[n - 1] ?? "")),
  );
}

export async function snapshot(payload: Payload): Promise<void> {
  const sessionId = payload.session_id;
  if (!sessionId) return;
  clearReported(sessionId);
  const root =
    payload.cwd && git(payload.cwd, ["rev-parse", "--show-toplevel"])?.trim();
  const tree = root ? worktreeTree(root) : null;
  if (root && tree) writeBaseline(sessionId, { root, tree });
  else clearBaseline(sessionId);
}

export async function sweep(payload: Payload): Promise<string | null> {
  const sessionId = payload.session_id;
  if (!sessionId) return null;
  const baseline = readBaseline(sessionId);
  if (!baseline) return null;

  const { root } = baseline;
  const tree = worktreeTree(root);
  if (!tree || tree === baseline.tree) return null;

  // Advance first, so a Stop that re-fires after the model's fix-up judges only the fix-up.
  const reported = readReported(sessionId);
  writeBaseline(sessionId, { root, tree });
  clearReported(sessionId);

  const names = git(root, [
    "diff-tree",
    "-r",
    "-z",
    "--name-only",
    "--no-renames",
    "--diff-filter=AM",
    baseline.tree,
    tree,
  ]);
  const files = (names ?? "")
    .split("\0")
    .filter((f) => f && isGuardedPath(f) && syntaxFor(f));
  if (files.length === 0 || files.length > MAX_FILES) return null;

  const reasons: string[] = [];
  for (const file of files) {
    const diff = git(root, [
      "diff-tree",
      "-p",
      "-U0",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      baseline.tree,
      tree,
      "--",
      file,
    ]);
    const hunks = parseHunks(diff ?? "");
    if (hunks.length === 0) continue;

    const abs = join(root, file);
    let text: string;
    try {
      text = await Bun.file(abs).text();
    } catch {
      continue;
    }
    const lines = text.split("\n").map((l) => l.trim());
    const added = withoutReported(
      resolveAdded(hunks, lines),
      lines,
      reported.get(abs),
    );
    if (added instanceof Set ? added.size === 0 : added.length === 0) continue;

    const blocks = flaggedBlocks(text, syntaxFor(file)!, added);
    if (blocks.length > 0) reasons.push(formatReason(file, blocks));
  }
  return reasons.length > 0 ? reasons.join("\n\n") : null;
}

async function main(): Promise<void> {
  let payload: Payload;
  try {
    payload = JSON.parse(await Bun.stdin.text());
  } catch {
    return;
  }
  if (process.argv[2] === "snapshot") return snapshot(payload);
  if (process.argv[2] !== "sweep") return;
  const reason = await sweep(payload);
  if (reason) console.log(JSON.stringify({ decision: "block", reason }));
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
