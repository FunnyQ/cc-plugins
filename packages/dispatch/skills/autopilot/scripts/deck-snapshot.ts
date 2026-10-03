import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  DeckAgent,
  DeckCrew,
  DeckSnapshot,
  DeckTask,
} from "../../../hooks/flightdeck/types.ts";
import { runLogPath } from "../../flightplan/scripts/lib/flightlog";
import { readRunId } from "./events-api";
import { aggregateFleet, type FleetRow } from "./fleet";
import { attributeUsage } from "./usage-attribute";
import { createTranscriptSource, repoRootOf } from "./usage-source";
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
// the web fleet's runElapsed: one clock per task, so concurrent lenses count once
function timeOf(rows: FleetRow[]): DeckTask["time"] {
  const started = rows.filter((row) => row.startedAt);
  if (started.length === 0) return null;
  const startMs = Math.min(...started.map((row) => Date.parse(row.startedAt!)));
  const endMs = started.some((row) => row.status === "in-flight")
    ? null
    : Math.max(...started.map((row) => Date.parse(row.startedAt!) + (row.elapsedMs ?? 0)));
  return {
    startedAt: new Date(startMs).toISOString(),
    endedAt: endMs === null ? null : new Date(endMs).toISOString(),
  };
}

export function buildDeckSnapshot(input: {
  plan: string;
  payload: TreePayload;
  fleet: FleetRow[];
  usage?: Map<string, number>; // billed tokens per ref, read only on a --usage run
  runTokens?: number; // the run's billed total, every attributed row included
}): DeckSnapshot {
  const { payload } = input;
  const rowsByRef = Map.groupBy(
    input.fleet.filter((row) => row.ref),
    (row) => row.ref!,
  );

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
      time: timeOf(rowsByRef.get(view.ref) ?? []),
      tokens: view.state === "done" ? (input.usage?.get(view.ref) ?? null) : null,
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
  // three rows show the scout or commit just finished beside the one running, without growing the box every wave
  const crew: DeckCrew[] = input.fleet
    .filter((row) => !row.ref || !tasks[row.ref])
    .sort((a, b) => (Date.parse(b.startedAt ?? "") || 0) - (Date.parse(a.startedAt ?? "") || 0))
    .slice(0, 3)
    .map((row) => ({
      role: row.role,
      label: row.label,
      status: row.status,
      startedAt: row.startedAt ?? null,
      elapsedMs: row.elapsedMs ?? null,
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
    crew,
    time: timeOf(input.fleet),
    tokens: input.runTokens ?? null,
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

// Claude tokens only: the codex side of a dev or review row is left to the web fleet
function readUsage(
  plan: string,
  deckSource: "tasks" | "graph",
  fleet: FleetRow[],
): { usage: Map<string, number>; runTokens: number } {
  const runId = deckSource === "graph" ? readRunId(plan) : undefined;
  const agents = createTranscriptSource(plan, undefined, repoRootOf(plan) ?? undefined).read(runId);
  const usage = new Map<string, number>();
  let runTokens = 0;
  for (const row of attributeUsage(fleet, agents).rows) {
    if (!row.usage) continue;
    const u = row.usage;
    const n = u.input + u.output + u.cacheRead + u.cacheWrite;
    runTokens += n;
    if (row.ref) usage.set(row.ref, (usage.get(row.ref) ?? 0) + n);
  }
  return { usage, runTokens };
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

  const withUsage = args.includes("--usage");
  const planArg = args.find((arg) => arg !== "--usage");
  if (planArg === undefined) {
    console.error("usage: deck-snapshot.ts <planDir> [--usage] | --latest <dir>");
    process.exit(1);
  }
  const plan = resolve(planArg);
  const deckSource = detectSource(plan);
  if (deckSource === "none") {
    console.error(`no tasks/ or graph.json in ${plan}`);
    process.exit(1);
  }

  const loaded =
    deckSource === "tasks" ? await loadPlan(plan) : await loadGraphPlan(plan);
  const payload = buildTreePayload({ ...loaded, deckSource });
  const fleet = aggregateFleet(loaded.entries);
  // a cold transcript read costs ~500 ms, so the pane asks for it only when a task newly lands
  const read = withUsage ? readUsage(plan, deckSource, fleet) : {};
  console.log(JSON.stringify(buildDeckSnapshot({ plan, payload, fleet, ...read })));
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(`deck-snapshot error: ${error.message}`);
    process.exit(1);
  });
}
