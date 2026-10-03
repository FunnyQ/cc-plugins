import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  DeckAgent,
  DeckSnapshot,
  DeckTask,
} from "../../../hooks/flightdeck/types.ts";
import { runLogPath } from "../../flightplan/scripts/lib/flightlog";
import { aggregateFleet, type FleetRow } from "./fleet";
import { detectSource, loadGraphPlan } from "./graph-source";
import { buildTreePayload, loadPlan, type TreePayload } from "./tree-api";

/** Pure: depth counts done tasks too, so rows never move as work lands. */
export function layerByDepth(tasks: { ref: string; dependsOn: string[] }[]): {
  waves: string[][];
  unschedulable: string[];
} {
  const wave = new Map<string, number>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const task of tasks) {
      if (wave.has(task.ref)) continue;
      if (!task.dependsOn.every((dep) => wave.has(dep))) continue;
      wave.set(
        task.ref,
        1 + Math.max(0, ...task.dependsOn.map((dep) => wave.get(dep)!)),
      );
      progressed = true;
    }
  }

  const waves: string[][] = [];
  const unschedulable: string[] = [];
  for (const task of tasks) {
    const n = wave.get(task.ref);
    if (n === undefined) unschedulable.push(task.ref);
    else (waves[n - 1] ??= []).push(task.ref);
  }
  return { waves, unschedulable: unschedulable.sort() };
}

/** Pure: shapes the payload and fleet into the pane's contract. */
export function buildDeckSnapshot(input: {
  plan: string;
  payload: TreePayload;
  fleet: FleetRow[];
}): DeckSnapshot {
  const { payload } = input;

  const tasks: Record<string, DeckTask> = {};
  for (const view of payload.tasks) {
    const score = view.latestScore;
    tasks[view.ref] = {
      ref: view.ref,
      title: view.title,
      state: view.state,
      attempts: view.attempts,
      score: score && {
        weighted: score.weighted,
        threshold: score.threshold,
        passed: score.passed,
      },
    };
  }

  const buckets = payload.buckets.map((name) => {
    const inBucket = payload.tasks.filter((task) => task.bucket === name);
    return {
      name,
      done: inBucket.filter((task) => task.state === "done").length,
      total: inBucket.length,
    };
  });

  const { waves, unschedulable } = layerByDepth(payload.tasks);
  const open = waves.findIndex((refs) =>
    refs.some((ref) => tasks[ref].state !== "done"),
  );

  // Rows without a start sort last; ISO strings from different writers may differ in offset, so compare as instants.
  const startOf = (row: FleetRow) =>
    row.startedAt === undefined ? Infinity : Date.parse(row.startedAt);
  const agents: DeckAgent[] = input.fleet
    .filter((row) => row.status === "in-flight")
    .sort((a, b) => startOf(a) - startOf(b))
    .map((row) => ({
      role: row.role,
      ref: row.ref ?? null,
      attempt: row.attempt ?? null,
      label: row.label,
      startedAt: row.startedAt ?? null,
    }));

  return {
    deckSource: payload.deckSource,
    plan: input.plan,
    slug: payload.slug,
    planTitle: payload.planTitle,
    counts: payload.counts,
    buckets,
    waves,
    unschedulable,
    currentWave: open === -1 ? null : open + 1,
    tasks,
    agents,
    errors: payload.errors.length,
  };
}

/** Impure: the plan under `<root>/docs/` whose run log was written last. */
export async function latestPlan(root: string): Promise<string | null> {
  const docs = resolve(root, "docs");
  let dirs: string[];
  try {
    dirs = (await readdir(docs, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  let best: { dir: string; mtime: number } | null = null;
  for (const name of dirs) {
    const dir = join(docs, name);
    try {
      const { mtimeMs } = await stat(runLogPath(dir));
      if (best === null || mtimeMs > best.mtime) best = { dir, mtime: mtimeMs };
    } catch {
      // A plan never flown has no run log; it is not a candidate.
    }
  }
  return best?.dir ?? null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "--latest") {
    const root = resolve(args[1] ?? ".");
    const plan = await latestPlan(root);
    if (plan === null) {
      console.error(`no flightplan run under ${root}/docs`);
      // 3, not 1: the pane answers "no run found" for this case alone
      process.exit(3);
    }
    console.log(JSON.stringify({ plan }));
    return;
  }

  if (args[0] === undefined) {
    console.error("usage: deck-snapshot.ts <planDir> | --latest <dir>");
    process.exit(1);
  }
  const plan = resolve(args[0]);
  const deckSource = detectSource(plan);
  if (deckSource === "none") {
    console.error(`no tasks/ or graph.json in ${plan}`);
    process.exit(1);
  }

  const loaded =
    deckSource === "tasks" ? await loadPlan(plan) : await loadGraphPlan(plan);
  const payload = buildTreePayload({ ...loaded, deckSource });
  // No token attribution: it reads transcripts, too costly for the pane's 2 s poll.
  const fleet = aggregateFleet(loaded.entries);
  console.log(JSON.stringify(buildDeckSnapshot({ plan, payload, fleet })));
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(`deck-snapshot error: ${error.message}`);
    process.exit(1);
  });
}
