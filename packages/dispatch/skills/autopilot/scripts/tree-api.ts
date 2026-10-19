import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadAllTasks } from "../../flightplan/scripts/next-ready";
import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import { readLog, runLogPath } from "../../flightplan/scripts/lib/flightlog";
import {
  type GraphNode,
  nodesFromParsedTasks,
} from "../../flightplan/scripts/lib/graph-node";
import { deriveTaskViews, type TaskState, type TaskView } from "./fleet";
import type { DeckSourceKind, PlanError } from "./graph-source";
import { repoRootOf } from "./usage-source";
import { summarizeWaves, type WaveSummary } from "./waves";

export type Loaded = {
  byRef: Record<string, GraphNode>;
  errors: PlanError[];
};

export type TreePayload = {
  deckSource: DeckSourceKind;
  slug: string;
  planTitle: string;
  repo: string;
  buckets: string[];
  tasks: TaskView[];
  counts: {
    total: number;
    done: number;
    inProgress: number;
    ready: number;
    blocked: number;
    invalid: number;
  };
  waves: WaveSummary;
  errors: PlanError[];
};

export function repoName(planDir: string): string {
  const root = repoRootOf(planDir);
  return root === null ? "" : basename(root);
}

export async function loadPlan(planDir: string): Promise<{
  slug: string;
  planTitle: string;
  repo: string;
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
    bucketDirs: taskResult.buckets,
    loaded: {
      byRef: nodesFromParsedTasks(taskResult.byRef),
      errors: taskResult.errors.map((error) => ({
        ...error,
        bucket: basename(dirname(error.file)),
      })),
    },
    entries,
  };
}

const COUNT_KEY = {
  done: "done",
  "in-progress": "inProgress",
  ready: "ready",
  blocked: "blocked",
  invalid: "invalid",
} as const satisfies Record<TaskState, string>;

export function buildTreePayload(input: {
  deckSource?: DeckSourceKind;
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
    deckSource: input.deckSource ?? "tasks",
    slug: input.slug,
    planTitle: input.planTitle,
    repo: input.repo,
    buckets:
      input.deckSource === "graph"
        ? [...input.bucketDirs]
        : [...input.bucketDirs].sort(),
    tasks,
    counts,
    waves: summarizeWaves(tasks, input.entries),
    errors: input.loaded.errors,
  };
}
