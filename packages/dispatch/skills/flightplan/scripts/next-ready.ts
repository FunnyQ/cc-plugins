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
 *   bun next-ready.ts <tasks-dir>
 *
 * Exits 0 when the tree is clean and either lists ready tasks or prints
 * nothing (so a shell loop is safe). Exits 1 when any task file fails to
 * parse — silently dropping malformed tasks would hide work from the
 * executor and make the list look complete.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseTask,
  refToString,
  type ParsedTask,
  type TaskRef,
} from "./lib/parse-task";

export type LoadError = { file: string; reason: string };

export type LoadResult = {
  byRef: Record<string, ParsedTask>;
  errors: LoadError[];
};

export async function loadAllTasks(tasksDir: string): Promise<LoadResult> {
  const byRef: Record<string, ParsedTask> = {};
  const refToFile = new Map<string, string>();
  const errors: LoadError[] = [];
  const buckets = await readdir(tasksDir, { withFileTypes: true });
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    if (bucket.name === "_context") continue;
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
    }
  }
  return { byRef, errors };
}

export function findReady(byRef: Record<string, ParsedTask>): TaskRef[] {
  const ready: TaskRef[] = [];
  for (const task of Object.values(byRef)) {
    if (task.status !== "todo") continue;
    const allDepsDone = task.dependsOn.every((dep) => {
      const upstream = byRef[refToString(dep)];
      return upstream?.status === "done";
    });
    if (allDepsDone) {
      ready.push({ bucket: task.bucket, nn: task.nn });
    }
  }
  ready.sort(
    (a, b) => a.bucket.localeCompare(b.bucket) || a.nn.localeCompare(b.nn),
  );
  return ready;
}

async function main() {
  const tasksDir = process.argv[2];
  if (!tasksDir) {
    console.error("Usage: bun next-ready.ts <tasks-dir>");
    process.exit(2);
  }
  const { byRef, errors } = await loadAllTasks(tasksDir);

  if (errors.length > 0) {
    console.error(
      `Cannot compute ready tasks — ${errors.length} task file(s) have errors:`,
    );
    for (const e of errors) {
      console.error(`  ${e.file}: ${e.reason}`);
    }
    process.exit(1);
  }

  const ready = findReady(byRef);
  for (const ref of ready) {
    console.log(refToString(ref));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("next-ready error:", err.message);
    process.exit(1);
  });
}
