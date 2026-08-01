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
 *   bun next-ready.ts <tasks-dir> --json       # [{ref,finalReview,path}]
 *   bun next-ready.ts <tasks-dir> --summary    # {ready,counts,invalid,errors}
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

export type LoadError = { file: string; reason: string };

/** A task that parsed but whose execution state is malformed. */
export type InvalidTask = {
  ref: string;
  file: string;
  rule: "status" | "completion-state";
  reason: string;
};

export type LoadResult = {
  byRef: Record<string, ParsedTask>;
  pathByRef: Record<string, string>;
  /**
   * Every bucket directory under `tasks/`, in listing order. Carried here so
   * the "a bucket is a directory that is not `_context`" rule lives once — a
   * consumer that needs empty buckets never re-lists the tree itself.
   */
  buckets: string[];
  errors: LoadError[];
  /**
   * Tasks that parsed but hold an invalid execution state (see `taskValidity`).
   * They stay in `byRef` on purpose — the dashboard must render them as invalid
   * rather than drop them — so every consumer decides for itself whether an
   * invalid task is fatal. The CLI treats it as fatal.
   */
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

/**
 * The dependencies of `task` that are not satisfied yet, as refs.
 *
 * The readiness rule lives here alone: a dependency is satisfied only when the
 * upstream task is *validly* complete — `Status: done` with every gate checkbox
 * ticked. A task claiming `done` over unticked boxes keeps blocking, so a lost
 * gate result can never unlock downstream work. `findReady` and the flightdeck's
 * task views both read this, so the CLI and the dashboard can never disagree
 * about what blocks.
 */
export function unmetDependencies(
  task: ParsedTask,
  byRef: Record<string, ParsedTask>,
): string[] {
  return task.dependsOn.map(refToString).filter((ref) => {
    const dep = byRef[ref];
    return dep === undefined || taskValidity(dep).kind !== "complete";
  });
}

/** A ready task ref plus whether it is the closing final-review task. */
export type ReadyRef = { ref: string; finalReview: boolean; path: string };

/**
 * Same ready set as `findReady`, but each entry carries its `finalReview`
 * flag and is pre-stringified. This is what the `--json` mode emits so an
 * executor (e.g. autopilot's scout) can consume the ready set verbatim —
 * without re-deriving `finalReview` by opening files (and without an LLM
 * having to interpret line-oriented output, where empty = "no ready tasks"
 * is easy to get wrong).
 */
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
    };
  });
}

/**
 * Whole-tree status counts. `total` always equals the sum of the five buckets,
 * so a consumer can assert that identity instead of trusting the caller.
 */
export type TreeCounts = {
  total: number;
  todo: number;
  inProgress: number;
  done: number;
  blocked: number;
  invalid: number;
};

/**
 * One authoritative snapshot of the tree: what is ready now, and how the whole
 * tree is distributed across statuses.
 *
 * autopilot's wave loop needs this because its own `completed` array only
 * covers the *current* run. A resumed run inherits `done` tasks from earlier
 * runs, so `completed.length === total` is never a completion test. `done ===
 * total` here is, because it counts the tree rather than the run.
 */
export function summarizeTree(
  byRef: Record<string, ParsedTask>,
  pathByRef: Record<string, string>,
): {
  ready: ReadyRef[];
  counts: TreeCounts;
  /**
   * Every task that is not validly complete, so a stalled executor can name the
   * remaining work instead of reporting a bare count.
   */
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
    // Invalid wins over the raw Status: a task claiming `done` over an unticked
    // gate box must never be counted toward completion.
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
  for (const task of Object.values(byRef)) {
    if (task.status !== "todo") continue;
    if (unmetDependencies(task, byRef).length === 0) {
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

  // --summary reports before it exits: the caller needs the invalid refs to
  // escalate, and a bare non-zero exit would hide them.
  if (summaryMode) {
    const { ready, counts, unfinished } = summarizeTree(byRef, pathByRef);
    console.log(JSON.stringify({ ready, counts, unfinished, invalid, errors }));
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

  // An invalid task is not "not ready" — it is a tree whose completion state
  // cannot be trusted. Returning a ready set here would either unlock work
  // behind a fake `done`, or print an empty set that reads as "all finished".
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
    // Always valid JSON — an empty ready set prints `[]`, never blank, so a
    // consumer can't mistake "done" for "everything is ready".
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
