#!/usr/bin/env bun
import { lstatSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { logRoot, STALE_MS } from "../../../shared/scripts/cockpit-trail";
import { bucketDirectory } from "./archive-plan";
import type {
  ArchivePlan,
  ArchiveTarget,
  Move,
  Refusal,
  SourceBucket,
} from "./archive-plan";

/** `moved` carries the moves that actually ran, so callers never re-probe the filesystem to find out which. */
export type ApplyResult = { moved: Move[]; failed: Refusal[] };

function probeLstat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function sessionIdOf(move: Move): string {
  return basename(move.from, ".jsonl");
}

function sourceDirectory(trustedRoot: string, bucket: SourceBucket): string {
  return realpathSync(bucketDirectory(trustedRoot, bucket));
}

function validateDestinationAncestors(
  trustedRoot: string,
  target: ArchiveTarget,
  errors: string[],
): void {
  const components = [
    join(trustedRoot, ".cockpit"),
    join(trustedRoot, ".cockpit", "archive"),
    bucketDirectory(trustedRoot, target),
  ];

  for (const component of components) {
    if (probeLstat(component)?.isSymbolicLink()) {
      errors.push(`Destination ancestor is a symlink: ${component}`);
    }
  }
}

/** Structural validation of an untrusted plan. Pure apart from lstat/realpath probes. */
export function validatePlan(plan: ArchivePlan, trustedRoot: string): string[] {
  const errors: string[] = [];
  let realTrustedRoot: string;

  try {
    realTrustedRoot = realpathSync(trustedRoot);
  } catch {
    return [`Trusted trail root does not exist: ${trustedRoot}`];
  }

  // The caller derives trustedRoot from cwd so an untrusted plan cannot choose the
  // filesystem boundary within which it is allowed to operate.
  if (resolve(plan.trailRoot) !== realTrustedRoot) {
    errors.push(
      `Plan trail root does not match trusted root: ${plan.trailRoot}`,
    );
  }

  const sourceDirectories = new Map<SourceBucket, string>();
  for (const bucket of ["inbox", "watch"] as const) {
    if (!plan.moves.some((move) => move.fromBucket === bucket)) continue;
    try {
      sourceDirectories.set(bucket, sourceDirectory(realTrustedRoot, bucket));
    } catch {
      errors.push(`Source directory does not exist for ${bucket} bucket.`);
    }
  }

  const checkedTargets = new Set<ArchiveTarget>();
  for (const move of plan.moves) {
    const targetValid = move.target === "done" || move.target === "watch";
    const bucketValid =
      move.fromBucket === "inbox" || move.fromBucket === "watch";

    if (!targetValid) {
      errors.push(`Invalid archive target: ${String(move.target)}`);
    }
    if (!bucketValid) {
      errors.push(`Invalid source bucket: ${String(move.fromBucket)}`);
    }

    if (bucketValid) {
      const filename = basename(move.from);
      const sessionId = basename(move.from, ".jsonl");
      const expectedSource = sourceDirectories.get(move.fromBucket);

      // Validate source strings lexically. Realpathing the file would turn a source
      // removed after planning into a structural failure instead of a missing refusal.
      if (!expectedSource || dirname(move.from) !== expectedSource) {
        errors.push(
          `Source escapes its ${move.fromBucket} bucket: ${move.from}`,
        );
      }
      if (
        !filename.endsWith(".jsonl") ||
        sessionId.length === 0 ||
        filename !== `${sessionId}.jsonl`
      ) {
        errors.push(`Invalid session log filename: ${filename}`);
      }
    }

    if (targetValid) {
      // Layout comes from the shared helper; the filename stays derived from the
      // move's own source, so a destination renamed away from its source still fails.
      const expectedDestination = join(
        bucketDirectory(realTrustedRoot, move.target),
        basename(move.from),
      );
      if (resolve(move.to) !== expectedDestination) {
        errors.push(`Destination does not match archive target: ${move.to}`);
      }

      if (!checkedTargets.has(move.target)) {
        validateDestinationAncestors(realTrustedRoot, move.target, errors);
        checkedTargets.add(move.target);
      }
    }

    if (move.fromBucket === "watch" && move.target === "watch") {
      errors.push(
        `Invalid terminal transition: watch to watch for ${move.from}`,
      );
    }
  }

  return errors;
}

function refusal(
  move: Move,
  reason: Refusal["reason"],
  detail: string,
): Refusal {
  return { sessionId: sessionIdOf(move), reason, detail };
}

/**
 * The only function that touches the trail.
 * `trustedRoot` is resolved by the CALLER from cwd — never read from the plan.
 */
export async function applyArchive(
  plan: ArchivePlan,
  trustedRoot: string,
): Promise<ApplyResult> {
  const errors = validatePlan(plan, trustedRoot);
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const failed: Refusal[] = [];
  const eligible: Move[] = [];
  const destinationCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  for (const move of plan.moves) {
    const destination = resolve(move.to);
    destinationCounts.set(
      destination,
      (destinationCounts.get(destination) ?? 0) + 1,
    );
    sourceCounts.set(move.from, (sourceCounts.get(move.from) ?? 0) + 1);
  }

  // Re-stat immediately before mutation because files can change after planning.
  // Apply-time races refuse only the affected move so independent moves can proceed.
  for (const move of plan.moves) {
    if (
      (destinationCounts.get(resolve(move.to)) ?? 0) > 1 ||
      (sourceCounts.get(move.from) ?? 0) > 1
    ) {
      failed.push(
        refusal(
          move,
          "collision",
          `Multiple moves share a source or destination: ${move.from} → ${move.to}`,
        ),
      );
      continue;
    }

    const source = probeLstat(move.from);
    if (!source) {
      failed.push(
        refusal(move, "missing", `Source no longer exists: ${move.from}`),
      );
      continue;
    }
    if (source.isSymbolicLink()) {
      failed.push(
        refusal(move, "collision", `Source is a symlink: ${move.from}`),
      );
      continue;
    }
    // `source` is the lstat of a path just proven not to be a symlink, so its mtime
    // is the file's own. A second statSync would also throw unguarded if the file
    // vanished between the two calls.
    if (Date.now() - source.mtimeMs < STALE_MS) {
      failed.push(
        refusal(move, "live", `Source may still be active: ${move.from}`),
      );
      continue;
    }
    if (probeLstat(move.to)) {
      failed.push(
        refusal(move, "collision", `Destination already exists: ${move.to}`),
      );
      continue;
    }

    eligible.push(move);
  }

  // Structural violations abort above. Apply-time refusals are reported and skipped.
  // This second phase creates directories only after every move has been inspected,
  // then performs the eligible renames without deletion or overwrite behavior.
  for (const move of eligible) mkdirSync(dirname(move.to), { recursive: true });
  for (const move of eligible) renameSync(move.from, move.to);

  return { moved: eligible, failed };
}

function usage(): string {
  return "Usage: bun archive-logs.ts --plan <archive-plan.json> --apply";
}

function planPath(argv: string[]): string {
  let path: string | undefined;
  let apply = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      apply = true;
    } else if (argument === "--plan" && argv[index + 1]) {
      path = argv[index + 1];
      index += 1;
    } else {
      throw new Error(usage());
    }
  }

  if (!path || !apply) throw new Error(usage());
  return path;
}

async function main(): Promise<void> {
  try {
    const path = planPath(Bun.argv.slice(2));
    const plan = JSON.parse(await Bun.file(path).text()) as ArchivePlan;
    const result = await applyArchive(plan, logRoot(process.cwd()));

    for (const move of result.moved) {
      console.log(`Moved: ${move.from} → ${move.to}`);
    }
    for (const item of result.failed) {
      console.log(`Skipped ${item.sessionId}: ${item.reason}: ${item.detail}`);
    }
    console.log(
      `Summary: moved ${result.moved.length}, skipped ${result.failed.length}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
