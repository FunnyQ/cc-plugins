#!/usr/bin/env bun
/**
 * Output: silent unless a reportable block exists. Always exits 0.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askFor,
  flaggedBlocks,
  formatReason,
  isGuardedPath,
  patchLines,
  resolveAdded,
  syntaxFor,
  type CommentBlock,
  type Hunk,
} from "./comment-core.ts";
import { fetchPost } from "./jev-fetch.ts";
import { type Post, screenBlocks, screenNote } from "./jev-screen.ts";
import { triage } from "./jev-triage.ts";
import {
  clearBaseline,
  clearReported,
  readBaseline,
  readReported,
  writeBaseline,
} from "./sweep-state.ts";

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

export function movedOut(diff: string): Map<string, number> {
  const pool = new Map<string, number>();
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const from = /^--- (.*)$/m.exec(section)?.[1]?.replace(/^"|"$/g, "");
    if (!from || from === "/dev/null" || !syntaxFor(from.replace(/^a\//, ""))) {
      continue;
    }
    const { added, removed } = patchLines(parseHunks(section));
    const left = new Map<string, number>();
    for (const text of removed) left.set(text, (left.get(text) ?? 0) + 1);
    for (const { text } of added) {
      if (left.has(text)) left.set(text, left.get(text)! - 1);
    }
    for (const [text, n] of left) {
      if (n > 0) pool.set(text, (pool.get(text) ?? 0) + n);
    }
  }
  return pool;
}

function without(
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

type SweepOutput = {
  decision?: "block";
  reason?: string;
  systemMessage?: string;
};

export type Found = {
  report: string;
  blocks: number;
  ask: string;
  note: string | null;
  settled?: string[];
};

type Jev = { apiKey: string | undefined; fetch: Post; triage: boolean };

export async function collect(
  payload: Payload,
  jev: Jev = {
    apiKey: process.env.TYPESAFE_API_KEY,
    fetch: fetchPost,
    triage: false,
  },
): Promise<Found | null> {
  const sessionId = payload.session_id;
  if (!sessionId) return null;
  const baseline = readBaseline(sessionId);
  if (!baseline) return null;

  const { root } = baseline;
  const tree = worktreeTree(root);
  if (!tree || tree === baseline.tree) return null;

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

  const moved = movedOut(
    git(root, [
      "diff-tree",
      "-p",
      "-U0",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      baseline.tree,
      tree,
    ]) ?? "",
  );

  const found: { file: string; text: string; blocks: CommentBlock[] }[] = [];
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
    const added = without(
      without(resolveAdded(hunks, lines), lines, reported.get(abs)),
      lines,
      moved,
    );
    if (added instanceof Set ? added.size === 0 : added.length === 0) continue;

    const blocks = flaggedBlocks(text, syntaxFor(file)!, added);
    if (blocks.length > 0) found.push({ file, text, blocks });
  }

  // In parallel: 20 files asked one by one could outlast the hook's 10 s timeout.
  const screened = await Promise.all(
    found.map(({ file, blocks }) => screenBlocks(file, blocks, jev)),
  );
  const reasons = found.flatMap(({ file }, i) =>
    screened[i]!.kept.length > 0
      ? [formatReason(file, screened[i]!.kept, "🧹 comment-sweep")]
      : [],
  );
  const note = screenNote("🧹 comment-sweep", {
    kept: screened.flatMap((s) => s.kept),
    withdrawn: screened.reduce((n, s) => n + s.withdrawn, 0),
    slowestMs: Math.max(0, ...screened.map((s) => s.slowestMs ?? 0)),
  });
  const kept = screened.flatMap((s) => s.kept);
  if (reasons.length === 0 && !note) return null;
  const settled =
    jev.triage && kept.length > 0
      ? await triage(
          found.map(({ file, text }, i) => ({
            file,
            text,
            blocks: screened[i]!.kept,
          })),
          jev,
        )
      : null;
  return {
    report: reasons.join("\n\n"),
    blocks: kept.length,
    ask: askFor(kept),
    note,
    ...(settled && { settled }),
  };
}

export async function sweep(payload: Payload): Promise<SweepOutput | null> {
  const found = await collect(payload);
  if (!found) return null;
  const out: SweepOutput = {};
  if (found.report) {
    out.decision = "block";
    out.reason = `${found.report}\n\n${found.ask}`;
  }
  if (found.note) out.systemMessage = found.note;
  return out;
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
  const out =
    process.argv[3] === "--json"
      ? await collect(payload, {
          apiKey: process.env.TYPESAFE_API_KEY,
          fetch: fetchPost,
          triage: true,
        })
      : await sweep(payload);
  if (out) console.log(JSON.stringify(out));
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
