#!/usr/bin/env bun
/**
 * Waypoints roadmap CLI.
 *
 * Usage:
 *   bun waypoints.ts active <proj>
 *   bun waypoints.ts leg-scaffold <proj> <NN-slug> <bucket>[,<bucket>...]
 *   bun waypoints.ts advance <proj> [--dry-run] [--outcome "<text>"] [--date YYYY-MM-DD]
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type LegStatus = "done" | "active" | "pending";

export type Leg = {
  num: number;
  nn: string;
  slug: string;
  status: LegStatus;
  title: string;
  doneState: string;
  landedDate?: string;
  outcome?: string;
};

export type Roadmap = { title: string; legs: Leg[] };

export type LegScaffoldPlanInput = {
  proj: string;
  nnSlug: string;
  buckets: string[];
  docsRoot: string;
};

export type LegScaffoldPlan = {
  legsDir: string;
  legDir: string;
  createdDirs: string[];
};

const STATUS_BY_GLYPH: Record<string, LegStatus> = {
  x: "done",
  "~": "active",
  " ": "pending",
};

const GLYPH_BY_STATUS: Record<LegStatus, string> = {
  done: "x",
  active: "~",
  pending: " ",
};

const LEG_SLUG_REGEX = /^\d{2}-[a-z][a-z0-9-]*$/;
const BUCKET_REGEX = /^[a-z][a-z0-9]*$/;

export function parseRoadmap(md: string): Roadmap {
  const lines = md.split(/\r?\n/);
  const title = parseTitle(lines);
  const legsStart = lines.findIndex((line) => /^##\s+Legs\s*$/.test(line));
  if (legsStart === -1) {
    throw new Error("Malformed WAYPOINTS.md: missing ## Legs section.");
  }

  const legs: Leg[] = [];
  for (let i = legsStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break;
    const item = /^- \[([x~ ])\] (\d+)\. (.+)$/.exec(line);
    if (!item) continue;

    const [, glyph, rawNum, body] = item;
    const num = Number(rawNum);
    const nn = String(num).padStart(2, "0");
    const split = body.split(" — ");
    if (split.length < 2) {
      throw new Error(
        `Malformed leg ${num}: missing padded em dash separator.`,
      );
    }
    const title = split[0].trim();
    const doneState = split.slice(1).join(" — ").trim();
    if (!title || !doneState) {
      throw new Error(
        `Malformed leg ${num}: title and done-state are required.`,
      );
    }

    const continuation = collectContinuation(lines, i + 1);
    const pointer = /→\s+legs\/([^/]+)\//.exec(continuation);
    if (!pointer) {
      throw new Error(
        `Malformed leg ${num}: missing mandatory → legs/NN-slug/ pointer.`,
      );
    }
    const slug = normalizePointerSlug(pointer[1], nn);
    const afterPointer = continuation.slice(
      continuation.indexOf(pointer[0]) + pointer[0].length,
    );
    const landedDate = /(?:^|\s)· landed ([^·]+?)(?=\s+·|$)/
      .exec(afterPointer)?.[1]
      ?.trim();
    const outcome = /(?:^|\s)· outcome: (.+)$/.exec(afterPointer)?.[1]?.trim();

    legs.push({
      num,
      nn,
      slug,
      status: STATUS_BY_GLYPH[glyph],
      title,
      doneState,
      ...(landedDate ? { landedDate } : {}),
      ...(outcome ? { outcome } : {}),
    });
  }

  return { title, legs };
}

export function serializeRoadmap(roadmap: Roadmap): string {
  const lines = [
    `# ${roadmap.title}`,
    "",
    "> Rolling-wave roadmap. One leg planned in detail at a time.",
    "> Status: [x] done · [~] active (exactly one) · [ ] pending",
    "",
    "## Legs",
    "",
  ];

  for (const leg of roadmap.legs) {
    lines.push(
      `- [${GLYPH_BY_STATUS[leg.status]}] ${leg.num}. ${leg.title} — ${leg.doneState}`,
    );
    let pointer = `      → legs/${leg.slug}/`;
    if (leg.landedDate) pointer += ` · landed ${leg.landedDate}`;
    if (leg.outcome) pointer += ` · outcome: ${leg.outcome}`;
    lines.push(pointer);
  }

  return `${lines.join("\n")}\n`;
}

export function assertSingleActive(roadmap: Roadmap): void {
  const activeCount = roadmap.legs.filter(
    (leg) => leg.status === "active",
  ).length;
  if (activeCount > 1) {
    throw new Error(
      `Multiple active legs found (${activeCount}); expected at most one.`,
    );
  }
}

export function formatActive(
  roadmap: Roadmap,
  priorGoals: Record<string, string>,
): string {
  assertSingleActive(roadmap);
  const active = roadmap.legs.find((leg) => leg.status === "active");
  if (!active) {
    const complete =
      roadmap.legs.length > 0 &&
      roadmap.legs.every((leg) => leg.status === "done");
    if (complete) {
      throw new Error("No active leg — roadmap complete.");
    }
    throw new Error("No active leg — mark one pending leg [~] to start.");
  }

  const lines = [
    `ACTIVE: ${active.slug}`,
    `DONE-STATE: ${active.doneState}`,
    "PRIOR LANDED LEGS:",
  ];
  for (const leg of roadmap.legs.filter(
    (candidate) => candidate.status === "done",
  )) {
    lines.push(`- ${leg.slug} — ${leg.doneState}`);
    if (leg.outcome) lines.push(`  outcome: ${leg.outcome}`);
    const goal = priorGoals[leg.slug];
    if (goal) lines.push(`  goal: ${goal}`);
  }
  return lines.join("\n");
}

export function validateLegSlug(nnSlug: string): void {
  if (!LEG_SLUG_REGEX.test(nnSlug)) {
    throw new Error(
      `NN-slug must match NN-kebab-slug, e.g. 01-auth (got: ${JSON.stringify(nnSlug)})`,
    );
  }
}

export function validateBucket(bucket: string): void {
  if (!BUCKET_REGEX.test(bucket)) {
    throw new Error(
      `bucket must be a single lowercase token without internal dashes (got: ${JSON.stringify(bucket)})`,
    );
  }
}

export function parseBuckets(raw: string): string[] {
  return raw
    .split(",")
    .map((bucket) => bucket.trim())
    .filter(Boolean);
}

export function overviewFirstLine(md: string): string | null {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Overview\s*$/.test(line));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s+/.test(line)) return null;
    if (line) return line;
  }
  return null;
}

export function draftOutcome(runlog: string, planOverview: string): string {
  const finalReviewLine = firstFinalReviewLine(runlog);
  if (finalReviewLine) return cleanOutcome(finalReviewLine);

  const lastNarrativeLine = lastRunlogLine(runlog);
  if (lastNarrativeLine) return cleanOutcome(lastNarrativeLine);

  const firstPlanSentence = firstSentence(planOverview);
  if (firstPlanSentence) return cleanOutcome(`planned: ${firstPlanSentence}`);

  return "landed (no RUNLOG summary available)";
}

export function advanceRoadmap(
  roadmap: Roadmap,
  outcome: string,
  date: string,
): Roadmap {
  const activeIndex = roadmap.legs.findIndex((leg) => leg.status === "active");
  const pendingIndex = roadmap.legs.findIndex(
    (leg) => leg.status === "pending",
  );

  return {
    ...roadmap,
    legs: roadmap.legs.map((leg, index) => {
      if (index === activeIndex) {
        return {
          ...leg,
          status: "done",
          landedDate: date,
          outcome,
        };
      }
      if (index === pendingIndex) {
        return {
          ...leg,
          status: "active",
        };
      }
      return { ...leg };
    }),
  };
}

export function planLegScaffold(input: LegScaffoldPlanInput): LegScaffoldPlan {
  validateLegSlug(input.nnSlug);
  if (input.buckets.length === 0) {
    throw new Error("at least one bucket is required");
  }
  for (const bucket of input.buckets) validateBucket(bucket);

  const legsDir = join(input.docsRoot, input.proj, "legs");
  const legDir = join(legsDir, input.nnSlug);
  const tasksDir = join(legDir, "tasks");
  const createdDirs = [legDir, tasksDir, join(tasksDir, "_context")];

  for (const bucket of input.buckets) {
    createdDirs.push(join(tasksDir, bucket));
  }

  return { legsDir, legDir, createdDirs };
}

function parseTitle(lines: string[]): string {
  const heading = lines.find((line) => /^#\s+/.test(line));
  if (!heading) {
    throw new Error("Malformed WAYPOINTS.md: missing H1 title.");
  }
  return heading.replace(/^#\s+/, "").trim();
}

function collectContinuation(lines: string[], start: number): string {
  const continuation: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^- \[[x~ ]\] \d+\. /.test(lines[i])) break;
    if (/^##\s+/.test(lines[i])) break;
    if (lines[i].trim()) continuation.push(lines[i].trim());
  }
  return continuation.join(" ");
}

function normalizePointerSlug(pointerSlug: string, nn: string): string {
  const suffix = /^\d{2}-(.+)$/.exec(pointerSlug)?.[1] ?? pointerSlug;
  return `${nn}-${suffix}`;
}

function firstFinalReviewLine(runlog: string): string | null {
  const lines = runlog.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Final review\s*$/i.test(line));
  if (start === -1) return null;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s+/.test(line)) return null;
    if (line && !isHeading(line)) return line;
  }
  return null;
}

function lastRunlogLine(runlog: string): string | null {
  const lines = runlog.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line && !isHeading(line)) return line;
  }
  return null;
}

function firstSentence(text: string): string | null {
  const collapsed = text.trim().replace(/\s+/g, " ");
  if (!collapsed) return null;
  return /^[^.!?]+[.!?]/.exec(collapsed)?.[0] ?? collapsed;
}

function cleanOutcome(text: string): string {
  const cleaned = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 120);
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line);
}

async function main() {
  const [verb, ...args] = process.argv.slice(2);
  try {
    switch (verb) {
      case "active": {
        const [proj] = args;
        if (!proj) throw new Error("Usage: bun waypoints.ts active <proj>");
        const roadmap = parseRoadmap(
          await readFile(join("docs", proj, "WAYPOINTS.md"), "utf-8"),
        );
        const priorGoals: Record<string, string> = {};
        for (const leg of roadmap.legs.filter(
          (candidate) => candidate.status === "done",
        )) {
          try {
            const plan = await readFile(
              join("docs", proj, "legs", leg.slug, "PLAN.md"),
              "utf-8",
            );
            const goal = overviewFirstLine(plan);
            if (goal) priorGoals[leg.slug] = goal;
          } catch {
            // Best-effort only: missing prior plans should not hide the leg.
          }
        }
        console.log(formatActive(roadmap, priorGoals));
        return;
      }
      case "leg-scaffold": {
        const [proj, nnSlug, rawBuckets] = args;
        if (!proj || !nnSlug || !rawBuckets) {
          throw new Error(
            "Usage: bun waypoints.ts leg-scaffold <proj> <NN-slug> <bucket>[,<bucket>...]",
          );
        }
        const plan = planLegScaffold({
          proj,
          nnSlug,
          buckets: parseBuckets(rawBuckets),
          docsRoot: "docs",
        });
        await mkdir(plan.legsDir, { recursive: true });
        for (const dir of plan.createdDirs) {
          await mkdir(dir);
          console.log(`created ${dir}/`);
        }
        return;
      }
      case "advance": {
        const [proj, ...flags] = args;
        if (!proj) {
          throw new Error(
            'Usage: bun waypoints.ts advance <proj> [--dry-run] [--outcome "<text>"] [--date YYYY-MM-DD]',
          );
        }

        let dryRun = false;
        let outcome: string | null = null;
        let dateStr: string | null = null;

        for (let i = 0; i < flags.length; i++) {
          if (flags[i] === "--dry-run") {
            dryRun = true;
          } else if (flags[i] === "--outcome") {
            outcome = flags[++i] ?? null;
          } else if (flags[i] === "--date") {
            dateStr = flags[++i] ?? null;
          }
        }

        const waypointsPath = join("docs", proj, "WAYPOINTS.md");
        const roadmap = parseRoadmap(await readFile(waypointsPath, "utf-8"));
        const activeLeg = roadmap.legs.find((leg) => leg.status === "active");
        if (!activeLeg) {
          const complete =
            roadmap.legs.length > 0 &&
            roadmap.legs.every((leg) => leg.status === "done");
          if (complete) {
            console.error("No active leg — roadmap complete.");
          } else {
            console.error("No active leg — mark one pending leg [~] to start.");
          }
          process.exit(1);
        }

        const runlogPath = join(
          "docs",
          proj,
          "legs",
          activeLeg.slug,
          ".flightlog",
          "RUNLOG.md",
        );
        const planPath = join("docs", proj, "legs", activeLeg.slug, "PLAN.md");
        let runlog = "";
        let planOverview = "";

        try {
          runlog = await readFile(runlogPath, "utf-8");
        } catch {
          // Best-effort: RUNLOG may not exist yet.
        }

        try {
          const plan = await readFile(planPath, "utf-8");
          planOverview = overviewFirstLine(plan) || "";
        } catch {
          // Best-effort: PLAN.md may not exist yet.
        }

        const draftedOutcome = draftOutcome(runlog, planOverview);
        if (dryRun || !outcome) {
          console.log(`DRAFT OUTCOME: ${draftedOutcome}`);
          return;
        }

        const today = dateStr || new Date().toISOString().split("T")[0];
        const newRoadmap = advanceRoadmap(roadmap, outcome, today);
        await Bun.write(waypointsPath, serializeRoadmap(newRoadmap));

        const newActive = newRoadmap.legs.find(
          (leg) => leg.status === "active",
        );
        if (newActive) {
          console.log(
            `Landed ${activeLeg.slug}, promoting ${newActive.slug} to active.`,
          );
        } else {
          console.log(`Landed ${activeLeg.slug}. Roadmap complete.`);
        }
        return;
      }
      default:
        console.error(
          "Usage: bun waypoints.ts <active|leg-scaffold|advance> ...",
        );
        process.exit(2);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
