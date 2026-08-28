import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadAllTasks } from "../../flightplan/scripts/next-ready";
import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import { readLog, runLogPath } from "../../flightplan/scripts/lib/flightlog";
import type { ParsedTask } from "../../flightplan/scripts/lib/parse-task";
import { deriveTaskViews, type TaskState, type TaskView } from "./fleet";
import { repoRootOf } from "./usage-source";

export type Loaded = {
  byRef: Record<string, ParsedTask>;
  errors: { file: string; bucket: string; reason: string }[];
};

export type TreePayload = {
  slug: string;
  planTitle: string;
  /** Repo the plan lives in — empty when the plan sits outside one. */
  repo: string;
  buckets: string[];
  tasks: TaskView[];
  counts: {
    total: number;
    done: number;
    inProgress: number;
    ready: number;
    blocked: number;
    /**
     * Tasks whose completion state is malformed. Counted separately so the
     * dashboard can never present the tree as complete while one exists.
     */
    invalid: number;
  };
  errors: { file: string; bucket: string; reason: string }[];
};

/**
 * Impure: walks up for the repo the plan belongs to, empty when there is none.
 * The walk itself lives in `repoRootOf` — the transcript reader needs the same
 * answer as an absolute path, and two copies could disagree about which repo a
 * plan belongs to while both panels claim to describe it.
 */
export function repoName(planDir: string): string {
  const root = repoRootOf(planDir);
  return root === null ? "" : basename(root);
}

/** Impure: reads the tasks tree and the flightlog. */
export async function loadPlan(planDir: string): Promise<{
  slug: string;
  planTitle: string;
  repo: string;
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

  const [taskResult, entries] = await Promise.all([
    loadAllTasks(tasksDir),
    readLog(runLogPath(planDir)),
  ]);

  return {
    slug,
    planTitle,
    repo: repoName(planDir),
    // The loader already applied the bucket rule; re-listing here would state it twice.
    bucketDirs: taskResult.buckets,
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

/** Which counter each task state increments. Exhaustive over `TaskState`. */
const COUNT_KEY = {
  done: "done",
  "in-progress": "inProgress",
  ready: "ready",
  blocked: "blocked",
  invalid: "invalid",
} as const satisfies Record<TaskState, string>;

/** Pure: shapes the response. */
export function buildTreePayload(input: {
  slug: string;
  planTitle: string;
  repo: string;
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
    invalid: 0,
  };

  for (const task of tasks) counts[COUNT_KEY[task.state]] += 1;

  return {
    slug: input.slug,
    planTitle: input.planTitle,
    repo: input.repo,
    buckets: [...input.bucketDirs].sort(),
    tasks,
    counts,
    errors: input.loaded.errors,
  };
}
