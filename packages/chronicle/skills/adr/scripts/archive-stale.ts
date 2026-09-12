#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { logRoot } from "../../../shared/scripts/cockpit-trail";
import { applyArchive } from "./archive-logs";
import {
  bucketDirectory,
  mtimeOf,
  planArchive,
  type Assignment,
  type Move,
  type Refusal,
} from "./archive-plan";

export type ScanRoot = { dir: string; deep: boolean };

export type TrailResult = {
  trailRoot: string;
  /** Moved under `--apply`, planned otherwise. */
  moves: Move[];
  skipped: Refusal[];
  /** `null` when nothing moves or the trail sits outside a git repository. */
  archiveIgnored: boolean | null;
};

// `.stversions` is Syncthing's version store and `.Trash` the macOS bin: both hold
// copies of real trails that must not be archived a second time.
const PRUNED = new Set([
  ".git",
  "node_modules",
  ".stversions",
  ".Trash",
  ".cockpit",
]);

export function defaultScanRoots(home = homedir()): ScanRoot[] {
  return [
    { dir: join(home, "Projects"), deep: true },
    { dir: join(home, ".claude"), deep: true },
    { dir: join(home, ".config"), deep: true },
    // A deep walk of home would cover Library and every cache; only its own trail counts.
    { dir: home, deep: false },
  ];
}

function isTrail(directory: string): boolean {
  try {
    return statSync(bucketDirectory(directory, "inbox")).isDirectory();
  } catch {
    return false;
  }
}

export function findTrailRoots(scanRoots: ScanRoot[]): string[] {
  const found = new Set<string>();

  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // A symlink is never a Dirent directory, so a link loop is never walked.
      if (!entry.isDirectory()) continue;
      if (entry.name === ".cockpit" && isTrail(directory)) {
        found.add(realpathSync(directory));
      }
      if (PRUNED.has(entry.name)) continue;
      // Chronicle's own forward-test trails, in the checkout and in every plugin cache copy.
      if (entry.name === "fixtures" && basename(directory) === "references") {
        continue;
      }
      visit(join(directory, entry.name));
    }
  };

  for (const { dir, deep } of scanRoots) {
    if (deep) visit(dir);
    else if (isTrail(dir)) found.add(realpathSync(dir));
  }
  return [...found].sort();
}

/** `destinations` are relative to `trailRoot`. */
export function archiveIgnored(
  trailRoot: string,
  destinations: string[],
): boolean | null {
  // Every real destination, not one probe: a negation can re-include a single file name.
  const result = spawnSync(
    "git",
    ["-C", trailRoot, "check-ignore", ...destinations],
    { encoding: "utf8" },
  );
  if (result.status === 1) return false;
  if (result.status !== 0) return null;
  const ignored = result.stdout.split("\n").filter((line) => line.length > 0);
  return ignored.length === destinations.length;
}

export async function archiveTrail(
  trailRoot: string,
  opts: { apply: boolean },
): Promise<TrailResult> {
  const assignments: Assignment[] = readdirSync(
    bucketDirectory(trailRoot, "inbox"),
  )
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => ({ sessionId: basename(name, ".jsonl"), target: "done" }));
  const plan = planArchive(trailRoot, assignments, {
    nowMs: Date.now(),
    mtimeOf,
    exists: existsSync,
  });
  const ignored =
    plan.moves.length > 0
      ? archiveIgnored(
          trailRoot,
          plan.moves.map(({ to }) => relative(trailRoot, to)),
        )
      : null;

  if (!opts.apply) {
    return {
      trailRoot,
      moves: plan.moves,
      skipped: plan.refused,
      archiveIgnored: ignored,
    };
  }
  const { moved, failed } = await applyArchive(plan, trailRoot);
  return {
    trailRoot,
    moves: moved,
    skipped: [...plan.refused, ...failed],
    archiveIgnored: ignored,
  };
}

export function formatTrail(result: TrailResult, apply: boolean): string[] {
  const reasons = new Map<string, number>();
  for (const { reason } of result.skipped) {
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const detail = [...reasons]
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  const lines = [
    `${result.trailRoot}: ${apply ? "moved" : "would move"} ${result.moves.length}, skipped ${result.skipped.length}${detail ? ` (${detail})` : ""}`,
  ];
  if (result.archiveIgnored === false) {
    lines.push(
      '  warning: .cockpit/archive/ is not git-ignored, so archived logs can be committed. Add ".cockpit/archive/" to .gitignore — not ".cockpit/", which also hides files a repo tracks there.',
    );
  }
  return lines;
}

function usage(): string {
  return "Usage: bun archive-stale.ts [--all] [--apply]";
}

function parseArgs(argv: string[]): { all: boolean; apply: boolean } {
  let all = false;
  let apply = false;
  for (const argument of argv) {
    if (argument === "--all") all = true;
    else if (argument === "--apply") apply = true;
    else throw new Error(usage());
  }
  return { all, apply };
}

async function main(): Promise<void> {
  const { all, apply } = parseArgs(Bun.argv.slice(2));
  const trailRoots = all
    ? findTrailRoots(defaultScanRoots())
    : [logRoot(process.cwd())];
  if (!all && !isTrail(trailRoots[0])) {
    throw new Error(
      `No trail at ${trailRoots[0]}: .cockpit/logs/ does not exist.`,
    );
  }

  let moved = 0;
  let skipped = 0;
  let exposed = 0;
  let broken = 0;
  for (const trailRoot of trailRoots) {
    try {
      const result = await archiveTrail(trailRoot, { apply });
      moved += result.moves.length;
      skipped += result.skipped.length;
      if (result.archiveIgnored === false) exposed += 1;
      if (result.moves.length + result.skipped.length > 0) {
        for (const line of formatTrail(result, apply)) console.log(line);
      }
    } catch (error) {
      broken += 1;
      console.error(
        `${trailRoot}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(
    `Summary: ${trailRoots.length} trails, ${apply ? "moved" : "would move"} ${moved}, skipped ${skipped}, ${exposed} not git-ignored, ${broken} failed`,
  );
  if (broken > 0) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
