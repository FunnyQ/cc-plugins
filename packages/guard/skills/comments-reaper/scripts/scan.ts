#!/usr/bin/env bun
/**
 * Lists the comments `/guard:comments-reaper` puts to its reviewer. With paths,
 * every comment in every guarded file under them; without, the comment lines
 * changed since HEAD plus every untracked file. No size threshold and no
 * header exemption: a person asked for this scan, so nothing is too small.
 *
 *   bun scan.ts [path ...]
 *
 * Prints a one-line summary and one `report <path>` line per shard, never a report.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  flaggedBlocks,
  formatReason,
  isGuardedPath,
  resolveAdded,
  syntaxFor,
} from "../../../hooks/comment-core.ts";
import { parseHunks } from "../../../hooks/comment-sweep.ts";

// Measured: one reviewer handed 357 blocks judged them from the comment text alone, reading no code.
export const SHARD_BLOCKS = 60;
export const MAX_BLOCKS = SHARD_BLOCKS * 8;

const LABEL = "🪦 comments-reaper";

type Scan = {
  files: number;
  blocks: number;
  reports: string[];
  refused?: string;
};

function git(cwd: string, args: string[]): string | null {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

const split = (out: string | null) => (out ?? "").split("\0").filter(Boolean);

export function scan(cwd: string, paths: string[]): Scan {
  const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!root) {
    return {
      files: 0,
      blocks: 0,
      reports: [],
      refused: "not a git repository",
    };
  }

  const whole = new Set(
    paths.length > 0
      ? split(
          git(cwd, [
            "ls-files",
            "-z",
            "-co",
            "--exclude-standard",
            "--full-name",
            "--",
            ...paths,
          ]),
        )
      : split(git(root, ["ls-files", "-z", "-o", "--exclude-standard"])),
  );
  const changed =
    paths.length > 0
      ? []
      : split(
          git(root, [
            "diff",
            "HEAD",
            "-z",
            "--name-only",
            "--no-renames",
            "--diff-filter=AM",
          ]),
        );

  const found: { file: string; report: string; blocks: number }[] = [];
  for (const file of [...whole, ...changed]) {
    const syntax = isGuardedPath(file) ? syntaxFor(file) : null;
    if (!syntax) continue;
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n").map((l) => l.trim());
    const added = whole.has(file)
      ? new Set(lines.map((_, i) => i + 1))
      : resolveAdded(
          parseHunks(
            git(root, [
              "diff",
              "HEAD",
              "-U0",
              "--no-ext-diff",
              "--no-textconv",
              "--",
              file,
            ]) ?? "",
          ),
          lines,
        );
    const blocks = flaggedBlocks(text, syntax, added, { every: true });
    if (blocks.length > 0) {
      found.push({
        file,
        report: formatReason(file, blocks, LABEL),
        blocks: blocks.length,
      });
    }
  }

  const blocks = found.reduce((n, f) => n + f.blocks, 0);
  if (blocks > MAX_BLOCKS) {
    return {
      files: found.length,
      blocks,
      reports: [],
      refused: `${blocks} comment blocks, over the ${MAX_BLOCKS}-block limit; name a narrower path`,
    };
  }
  const shards: { report: string[]; blocks: number }[] = [];
  for (const f of found) {
    const last = shards.at(-1);
    if (last && last.blocks + f.blocks <= SHARD_BLOCKS) {
      last.report.push(f.report);
      last.blocks += f.blocks;
    } else shards.push({ report: [f.report], blocks: f.blocks });
  }
  return {
    files: found.length,
    blocks,
    reports: shards.map((s) => s.report.join("\n\n")),
  };
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  const out = scan(process.cwd(), paths);
  const scope = paths.length > 0 ? paths.join(" ") : "the changes since HEAD";
  if (out.refused) {
    console.log(`${LABEL}: refused: ${out.refused}`);
    process.exit(1);
  }
  if (out.files === 0) {
    console.log(`${LABEL}: no comments in ${scope}`);
    process.exit(0);
  }
  const base = "/tmp/q-lab/guard/comments-reaper";
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "scan-"));
  console.log(
    `${LABEL}: ${out.blocks} comment block(s) in ${out.files} file(s) of ${scope}`,
  );
  out.reports.forEach((report, i) => {
    const reportPath = join(dir, `report-${i + 1}.txt`);
    writeFileSync(reportPath, report);
    console.log(`report ${reportPath}`);
  });
}
