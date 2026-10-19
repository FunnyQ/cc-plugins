#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { logRoot, STALE_MS } from "../../../shared/scripts/cockpit-trail";
import { writeTempPayload } from "../../../shared/scripts/temp-payload";

export type ArchiveTarget = "done" | "watch";

export type SourceBucket = "inbox" | "watch";

export type Assignment = {
  sessionId: string;
  target: ArchiveTarget;
  from?: SourceBucket;
};

export type Move = {
  from: string;
  to: string;
  target: ArchiveTarget;
  fromBucket: SourceBucket;
};

export type Refusal = {
  sessionId: string;
  reason: "live" | "missing" | "collision" | "already-archived" | "no-op";
  detail: string;
};

export type ArchivePlan = {
  trailRoot: string;
  moves: Move[];
  refused: Refusal[];
};

export type PlanDeps = {
  nowMs: number;
  mtimeOf: (path: string) => number | null;
  exists: (path: string) => boolean;
};

export type TrailBucket = SourceBucket | ArchiveTarget;

// The one place the on-disk trail layout is written down. The collector, the planner
// and the applier's validator all route through it, so no two of them can drift apart.
export function bucketDirectory(
  trailRoot: string,
  bucket: TrailBucket,
): string {
  return bucket === "inbox"
    ? join(trailRoot, ".cockpit", "logs")
    : join(trailRoot, ".cockpit", "archive", bucket);
}

export function sessionPath(
  trailRoot: string,
  sessionId: string,
  bucket: TrailBucket,
): string {
  return join(bucketDirectory(trailRoot, bucket), `${sessionId}.jsonl`);
}

export function planArchive(
  trailRoot: string,
  assignments: Assignment[],
  deps: PlanDeps,
): ArchivePlan {
  const moves: Move[] = [];
  const refused: Refusal[] = [];

  for (const assignment of assignments) {
    const fromBucket = assignment.from ?? "inbox";
    const from = sessionPath(trailRoot, assignment.sessionId, fromBucket);
    const to = sessionPath(trailRoot, assignment.sessionId, assignment.target);
    const mtimeMs = deps.mtimeOf(from);

    if (mtimeMs !== null && deps.nowMs - mtimeMs < STALE_MS) {
      const ageSeconds = (deps.nowMs - mtimeMs) / 1_000;
      refused.push({
        sessionId: assignment.sessionId,
        reason: "live",
        detail: `Source is ${ageSeconds} seconds old and may still be active.`,
      });
      continue;
    }

    if (mtimeMs === null) {
      const done = sessionPath(trailRoot, assignment.sessionId, "done");
      const watch = sessionPath(trailRoot, assignment.sessionId, "watch");
      if (fromBucket === "inbox" && deps.exists(done) && !deps.exists(watch)) {
        refused.push({
          sessionId: assignment.sessionId,
          reason: "already-archived",
          detail: "Session is already in the terminal done archive.",
        });
      } else {
        refused.push({
          sessionId: assignment.sessionId,
          reason: "missing",
          detail: `No session file exists in the ${fromBucket} bucket.`,
        });
      }
      continue;
    }

    if (fromBucket === "watch" && assignment.target === "watch") {
      refused.push({
        sessionId: assignment.sessionId,
        reason: "no-op",
        detail: "Session is already in the watch bucket.",
      });
      continue;
    }

    if (deps.exists(to)) {
      refused.push({
        sessionId: assignment.sessionId,
        reason: "collision",
        detail: `Destination already exists: ${to}`,
      });
      continue;
    }

    moves.push({
      from,
      to,
      target: assignment.target,
      fromBucket,
    });
  }

  return { trailRoot, moves, refused };
}

export function everySessionMissing(plan: ArchivePlan): boolean {
  return (
    plan.moves.length === 0 &&
    plan.refused.length > 0 &&
    plan.refused.every(({ reason }) => reason === "missing")
  );
}

export async function writePlan(plan: ArchivePlan): Promise<string> {
  return writeTempPayload("adr", "archive-plan", plan);
}

function assignmentsPath(argv: string[]): string {
  const flagIndex = argv.indexOf("--assignments");
  const path = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  if (!path)
    throw new Error("Missing required --assignments <assignments.json>");
  return path;
}

export function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const path = assignmentsPath(Bun.argv.slice(2));
  const assignments = JSON.parse(await Bun.file(path).text()) as Assignment[];
  if (!Array.isArray(assignments)) {
    throw new Error("Assignments JSON must contain an array");
  }

  const trailRoot = logRoot(process.cwd());
  if (!existsSync(join(trailRoot, ".cockpit"))) {
    throw new Error(
      `No .cockpit trail at ${trailRoot}. Run the planner from the repo that owns these sessions.`,
    );
  }
  const plan = planArchive(trailRoot, assignments, {
    nowMs: Date.now(),
    mtimeOf,
    exists: existsSync,
  });
  if (everySessionMissing(plan)) {
    throw new Error(
      `Every session is missing from ${trailRoot}. Run the planner from the repo that owns these sessions.`,
    );
  }
  console.log(await writePlan(plan));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
