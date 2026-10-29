#!/usr/bin/env bun
/**
 * Lists the comments `/guard:comments-reaper` puts to its reviewer. With paths,
 * every comment in every guarded file under them; without, the comment lines
 * changed since HEAD plus every untracked file. No size threshold and no
 * header exemption: a person asked for this scan, so nothing is too small.
 *
 *   bun scan.ts [path ...]
 *
 * Prints a one-line summary and one `report <path> verdicts <path>` line per
 * shard, never a report. A file and its test always share a shard. Past
 * WAVE_SHARDS shards, a `wave N of M` line heads each group of at most
 * WAVE_SHARDS reports. `--workflow` prints only the shard count, the scan
 * directory and a flightdeck graph for reap.workflow.js.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  flaggedBlocks,
  formatReason,
  isGuardedPath,
  resolveAdded,
  syntaxFor,
} from "../../../hooks/comment-core.ts";
import { parseHunks } from "../../../hooks/comment-sweep.ts";

// Measured: one reviewer handed 357 blocks judged them from the comment text alone, reading no code.
export const scanRoot = (platform: string = process.platform): string =>
  platform === "win32"
    ? join(tmpdir(), "q-lab", "guard", "comments-reaper")
    : "/tmp/q-lab/guard/comments-reaper";

export const SHARD_BLOCKS = 60;
export const WAVE_SHARDS = 8;

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
  const units = new Map<string, { report: string[]; blocks: number }>();
  for (const f of found) {
    const stem = f.file.replace(/\.(mod\.)?(test|spec)(?=\.[^./]+$)/, "");
    const unit = units.get(stem) ?? { report: [], blocks: 0 };
    unit.report.push(f.report);
    unit.blocks += f.blocks;
    units.set(stem, unit);
  }
  const shards: { report: string[]; blocks: number }[] = [];
  for (const u of units.values()) {
    const last = shards.at(-1);
    if (last && last.blocks + u.blocks <= SHARD_BLOCKS) {
      last.report.push(...u.report);
      last.blocks += u.blocks;
    } else shards.push({ report: [...u.report], blocks: u.blocks });
  }
  return {
    files: found.length,
    blocks,
    reports: shards.map((s) => s.report.join("\n\n")),
  };
}

// A deck directory per scan, never cleaned: re-using one would need the user's leave to reset its trail.
export function writeDeck(
  dataHome: string,
  root: string,
  runId: string,
  shards: number,
): string | null {
  if (shards > 99) return null;
  const dir = join(dataHome, "q-lab/flightdeck", `comments-reaper-${runId}`);
  mkdirSync(dir, { recursive: true });
  const nodes = Array.from({ length: shards }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return { ref: `shard/${n}`, lane: "shards", title: `report-${i + 1}` };
  });
  writeFileSync(
    join(dir, "graph.json"),
    JSON.stringify({
      version: 1,
      title: "comments-reaper",
      repoRoot: root,
      lanes: ["shards"],
      nodes,
    }),
  );
  writeFileSync(join(dir, "run.id"), `${runId}\n`);
  return dir;
}

if (import.meta.main) {
  const workflow = process.argv.includes("--workflow");
  const paths = process.argv.slice(2).filter((a) => a !== "--workflow");
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
  const base = scanRoot();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "scan-"));
  console.log(
    `${LABEL}: ${out.blocks} comment block(s) in ${out.files} file(s) of ${scope}`,
  );
  out.reports.forEach((report, i) =>
    writeFileSync(join(dir, `report-${i + 1}.txt`), report),
  );
  if (workflow) {
    const dataHome =
      process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"])!.trim();
    const deck = writeDeck(dataHome, root, basename(dir), out.reports.length);
    console.log(`shards ${out.reports.length} in ${dir}`);
    console.log(deck ? `deck ${deck}` : "deck none: over 99 shards");
    process.exit(0);
  }
  const waves = Math.ceil(out.reports.length / WAVE_SHARDS);
  out.reports.forEach((_, i) => {
    if (waves > 1 && i % WAVE_SHARDS === 0)
      console.log(`wave ${i / WAVE_SHARDS + 1} of ${waves}`);
    console.log(
      `report ${join(dir, `report-${i + 1}.txt`)} verdicts ${join(dir, `verdicts-${i + 1}.txt`)}`,
    );
  });
}
