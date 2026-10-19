#!/usr/bin/env bun
/**
 * Find tasks whose dependencies are all `Status: done`. Returns the next
 * tasks an executor can safely pick up.
 *
 * Output: one task ref per line, e.g.
 *   ui/03
 *   backend/02
 *
 * Usage:
 *   bun next-ready.ts <tasks-dir>              # one ref per line
 *   bun next-ready.ts <tasks-dir> --json       # [{ref,finalReview,path,modelsRaw}]
 *   bun next-ready.ts <tasks-dir> --summary    # {ready,counts,invalid,errors,maxParallel}
 *
 * Exits 0 when the tree is clean and either lists ready tasks or prints
 * nothing (so a shell loop is safe). Exits 1 when any task file fails to
 * parse, or when any task holds an invalid execution state — silently
 * dropping either would hide work from the executor and make the list look
 * complete.
 *
 * `--summary` prints its JSON snapshot BEFORE exiting non-zero, so a caller
 * can name the invalid refs in its escalation instead of reporting a bare
 * failure.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseTask,
  refToString,
  taskValidity,
  type ParsedTask,
  type TaskRef,
} from "./lib/parse-task";
import { nodesFromParsedTasks, unmetNodeDependencies } from "./lib/graph-node";
import { parseMaxParallel, readPlan } from "./lib/max-parallel";

export type LoadError = { file: string; reason: string };

export type InvalidTask = {
  ref: string;
  file: string;
  rule: "status" | "completion-state";
  reason: string;
};

export type LoadResult = {
  byRef: Record<string, ParsedTask>;
  pathByRef: Record<string, string>;
  buckets: string[];
  errors: LoadError[];
  invalid: InvalidTask[];
};

export async function loadAllTasks(tasksDir: string): Promise<LoadResult> {
  const byRef: Record<string, ParsedTask> = {};
  const pathByRef: Record<string, string> = {};
  const refToFile = new Map<string, string>();
  const errors: LoadError[] = [];
  const invalid: InvalidTask[] = [];
  const bucketNames: string[] = [];
  const buckets = await readdir(tasksDir, { withFileTypes: true });
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    if (bucket.name === "_context") continue;
    bucketNames.push(bucket.name);
    const bucketDir = join(tasksDir, bucket.name);
    const files = await readdir(bucketDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      if (file === "README.md") continue;
      const path = join(bucketDir, file);
      const content = await readFile(path, "utf-8");
      const parsed = parseTask(content);
      if (!parsed.ok) {
        errors.push({ file: path, reason: parsed.reason });
        continue;
      }
      const ref = refToString(parsed.task);
      const existing = refToFile.get(ref);
      if (existing) {
        errors.push({
          file: path,
          reason: `duplicate ref ${ref} (already claimed by ${existing})`,
        });
        continue;
      }
      refToFile.set(ref, path);
      byRef[ref] = parsed.task;
      pathByRef[ref] = path;
      const validity = taskValidity(parsed.task);
      if (validity.kind === "invalid") {
        invalid.push({
          ref,
          file: path,
          rule: validity.rule,
          reason: validity.reason,
        });
      }
    }
  }
  return { byRef, pathByRef, buckets: bucketNames, errors, invalid };
}

export type ReadyRef = {
  ref: string;
  finalReview: boolean;
  path: string;
  modelsRaw: string | null;
};

export function findReadyDetailed(
  byRef: Record<string, ParsedTask>,
  pathByRef: Record<string, string>,
): ReadyRef[] {
  return findReady(byRef).map((r) => {
    const ref = refToString(r);
    return {
      ref,
      finalReview: byRef[ref]?.finalReview ?? false,
      path: pathByRef[ref] ?? "",
      modelsRaw: byRef[ref]?.modelsRaw ?? null,
    };
  });
}

export type TreeCounts = {
  total: number;
  todo: number;
  inProgress: number;
  done: number;
  blocked: number;
  invalid: number;
};

export function summarizeTree(
  byRef: Record<string, ParsedTask>,
  pathByRef: Record<string, string>,
): {
  ready: ReadyRef[];
  counts: TreeCounts;
  unfinished: { ref: string; state: keyof Omit<TreeCounts, "total"> }[];
} {
  const counts: TreeCounts = {
    total: 0,
    todo: 0,
    inProgress: 0,
    done: 0,
    blocked: 0,
    invalid: 0,
  };
  const unfinished: { ref: string; state: keyof Omit<TreeCounts, "total"> }[] =
    [];

  for (const [ref, task] of Object.entries(byRef)) {
    counts.total += 1;
    const validity = taskValidity(task);
    let state: keyof Omit<TreeCounts, "total">;
    if (validity.kind === "invalid") state = "invalid";
    else if (task.status === "done") state = "done";
    else if (task.status === "in-progress") state = "inProgress";
    else if (task.status === "blocked") state = "blocked";
    else state = "todo";
    counts[state] += 1;
    if (state !== "done") unfinished.push({ ref, state });
  }

  unfinished.sort((a, b) => a.ref.localeCompare(b.ref));
  return { ready: findReadyDetailed(byRef, pathByRef), counts, unfinished };
}

export function findReady(byRef: Record<string, ParsedTask>): TaskRef[] {
  const ready: TaskRef[] = [];
  const nodes = nodesFromParsedTasks(byRef);
  for (const [ref, task] of Object.entries(byRef)) {
    if (task.status !== "todo") continue;
    if (unmetNodeDependencies(nodes[ref]!, nodes).length === 0) {
      ready.push({ bucket: task.bucket, nn: task.nn });
    }
  }
  ready.sort(
    (a, b) => a.bucket.localeCompare(b.bucket) || a.nn.localeCompare(b.nn),
  );
  return ready;
}

async function main() {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes("--json");
  const summaryMode = argv.includes("--summary");
  const tasksDir = argv.find((a) => !a.startsWith("--"));
  if (!tasksDir) {
    console.error("Usage: bun next-ready.ts <tasks-dir> [--json | --summary]");
    process.exit(2);
  }
  const { byRef, pathByRef, errors, invalid } = await loadAllTasks(tasksDir);

  if (summaryMode) {
    const { ready, counts, unfinished } = summarizeTree(byRef, pathByRef);
    const planPath = join(tasksDir, "..", "PLAN.md");
    let maxParallel: number | null = null;
    let plan: string | null = null;
    try {
      plan = await readPlan(planPath);
    } catch (error) {
      errors.push({
        file: planPath,
        reason: `cannot read PLAN.md, so its Max parallel cap is unknown: ${(error as Error).message}`,
      });
    }
    if (plan !== null) {
      const parsed = parseMaxParallel(plan);
      if (parsed.ok) maxParallel = parsed.value;
      else errors.push({ file: planPath, reason: parsed.reason });
    }
    console.log(
      JSON.stringify({
        ready,
        counts,
        unfinished,
        invalid,
        errors,
        maxParallel,
      }),
    );
    if (errors.length > 0 || invalid.length > 0) process.exit(1);
    return;
  }

  if (errors.length > 0) {
    console.error(
      `Cannot compute ready tasks — ${errors.length} task file(s) have errors:`,
    );
    for (const e of errors) {
      console.error(`  ${e.file}: ${e.reason}`);
    }
    process.exit(1);
  }

  if (invalid.length > 0) {
    console.error(
      `Cannot compute ready tasks — ${invalid.length} task(s) have an invalid execution state:`,
    );
    for (const i of invalid) {
      console.error(`  ${i.ref} (${i.file})  [${i.rule}] ${i.reason}`);
    }
    process.exit(1);
  }

  if (jsonMode) {
    console.log(JSON.stringify(findReadyDetailed(byRef, pathByRef)));
  } else {
    for (const ref of findReady(byRef)) {
      console.log(refToString(ref));
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("next-ready error:", err.message);
    process.exit(1);
  });
}
