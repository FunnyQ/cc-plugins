import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadAllTasks } from "../../flightplan/scripts/next-ready";
import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import { readLog } from "../../flightplan/scripts/lib/flightlog";
import type { ParsedTask } from "../../flightplan/scripts/lib/parse-task";
import { deriveTaskViews, type TaskView } from "./fleet";

export type Loaded = {
  byRef: Record<string, ParsedTask>;
  errors: { file: string; bucket: string; reason: string }[];
};

export type TreePayload = {
  slug: string;
  planTitle: string;
  buckets: string[];
  tasks: TaskView[];
  counts: {
    total: number;
    done: number;
    inProgress: number;
    ready: number;
    blocked: number;
  };
  errors: { file: string; bucket: string; reason: string }[];
};

/** Impure: reads the tasks tree and the flightlog. */
export async function loadPlan(planDir: string): Promise<{
  slug: string;
  planTitle: string;
  /**
   * Every directory under `tasks/`, in listing order — NOT derived from parsed
   * tasks. `buildTreePayload` owns the ordering rule.
   */
  bucketDirs: string[];
  loaded: Loaded;
  entries: FlightlogEntry[];
}> {
  const slug = basename(planDir);
  const tasksDir = join(planDir, "tasks");

  let planTitle = slug;
  try {
    const plan = await readFile(join(planDir, "PLAN.md"), "utf-8");
    planTitle = plan.match(/^# (.+)$/m)?.[1] ?? slug;
  } catch {
    // An unreadable PLAN.md leaves the slug as the title.
  }

  const [taskResult, taskEntries] = await Promise.all([
    loadAllTasks(tasksDir),
    readdir(tasksDir, { withFileTypes: true }),
  ]);
  const bucketDirs = taskEntries
    .filter((entry) => entry.isDirectory() && entry.name !== "_context")
    .map((entry) => entry.name);

  const entries = await readLog(join(planDir, ".flightlog", "run.jsonl"));

  return {
    slug,
    planTitle,
    bucketDirs,
    loaded: {
      byRef: taskResult.byRef,
      errors: taskResult.errors.map((error) => ({
        ...error,
        bucket: basename(dirname(error.file)),
      })),
    },
    entries,
  };
}

/** Pure: shapes the response. */
export function buildTreePayload(input: {
  slug: string;
  planTitle: string;
  bucketDirs: string[];
  loaded: Loaded;
  entries: FlightlogEntry[];
}): TreePayload {
  const tasks = deriveTaskViews(input.loaded.byRef, input.entries);
  const counts = {
    total: tasks.length,
    done: 0,
    inProgress: 0,
    ready: 0,
    blocked: 0,
  };

  for (const task of tasks) {
    if (task.state === "done") counts.done += 1;
    if (task.state === "in-progress") counts.inProgress += 1;
    if (task.state === "ready") counts.ready += 1;
    if (task.state === "blocked") counts.blocked += 1;
  }

  return {
    slug: input.slug,
    planTitle: input.planTitle,
    buckets: [...input.bucketDirs].sort(),
    tasks,
    counts,
    errors: input.loaded.errors,
  };
}
