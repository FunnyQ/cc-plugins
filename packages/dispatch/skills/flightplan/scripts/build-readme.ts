#!/usr/bin/env bun
/**
 * Regenerate tasks/README.md from the task files under tasks/<bucket>/*.md.
 *
 * The generated block is wrapped in HTML markers so human-authored prologue
 * and epilogue (e.g. "Known gaps") survive regeneration:
 *
 *   <!-- flightplan:generated:start -->
 *   ...task index, dep graphs, cross-bucket table...
 *   <!-- flightplan:generated:end -->
 *
 * The script fails loudly (exit 1, no write) if any task file is malformed or
 * if two files claim the same bucket/NN ref — silent skipping would produce a
 * README that looks complete while omitting tasks.
 *
 * Usage:
 *   bun build-readme.ts <tasks-dir>
 */
import { readdir, readFile, writeFile, access } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseTask, refToString, type ParsedTask } from "./lib/parse-task";

export const GEN_START = "<!-- flightplan:generated:start -->";
export const GEN_END = "<!-- flightplan:generated:end -->";

export type LoadError = { file: string; reason: string };

export type LoadResult = {
  /** Tasks indexed by `bucket/NN`. */
  tasks: Record<string, ParsedTask>;
  /** Files that failed to parse or duplicate an existing ref. */
  errors: LoadError[];
};

export async function loadTasks(tasksDir: string): Promise<LoadResult> {
  const tasks: Record<string, ParsedTask> = {};
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
      tasks[ref] = parsed.task;
    }
  }
  return { tasks, errors };
}

export function renderGenerated(input: {
  tasks: Record<string, ParsedTask>;
}): string {
  const tasks = Object.values(input.tasks);
  const byBucket = new Map<string, ParsedTask[]>();
  for (const t of tasks) {
    if (!byBucket.has(t.bucket)) byBucket.set(t.bucket, []);
    byBucket.get(t.bucket)!.push(t);
  }
  for (const list of byBucket.values()) {
    list.sort((a, b) => a.nn.localeCompare(b.nn));
  }

  const sections: string[] = [];

  sections.push("## Status conventions");
  sections.push("");
  sections.push(
    "Each task header has a `> **Status**: <status>` line. Executors update it as they go:",
  );
  sections.push("");
  sections.push("- `todo` — not started");
  sections.push("- `in-progress` — actively being worked on");
  sections.push("- `done` — merged / shipped");
  sections.push(
    "- `blocked` — waiting on a decision, upstream task, or external resource",
  );

  sections.push("");
  sections.push("## Task index");
  sections.push("");
  sections.push("| Bucket | NN | Title | Status | Pass 線 | Depends on |");
  sections.push("|---|---|---|---|---|---|");
  for (const bucket of [...byBucket.keys()].sort()) {
    for (const t of byBucket.get(bucket)!) {
      const deps =
        t.dependsOn.length === 0
          ? "—"
          : t.dependsOn.map(refToString).join(", ");
      const pass = t.rubric
        ? `${t.rubric.passOp} ${t.rubric.passThreshold}`
        : "—";
      sections.push(
        `| ${t.bucket} | ${t.nn} | ${escapeCell(t.title)} | ${t.status ?? "?"} | ${pass} | ${deps} |`,
      );
    }
  }

  sections.push("");
  sections.push("## Dependency graph");
  sections.push("");
  sections.push("```");
  const { graph, hasMultiParent } = renderGlobalGraph(tasks);
  sections.push(graph);
  sections.push("```");
  if (hasMultiParent) {
    sections.push("");
    sections.push(
      "`*` = task has additional dependencies beyond the parent shown above; see the **Task index** for the full `Depends on` list.",
    );
  }

  if (byBucket.size > 1) {
    const crossLinks = collectCrossBucket(tasks);
    if (crossLinks.length > 0) {
      sections.push("");
      sections.push("## Cross-bucket dependencies");
      sections.push("");
      sections.push(
        "<!-- Add a third column (Why) by hand if the rationale would help executors. -->",
      );
      sections.push("");
      sections.push("| Task | Depends on |");
      sections.push("|---|---|");
      for (const { from, deps } of crossLinks) {
        sections.push(`| ${from} | ${deps.join(", ")} |`);
      }
    }
  }

  return sections.join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/**
 * Render every task as a single global tree.
 *
 * Each task hangs under its **primary parent** — the first entry in its
 * `Depends on:` list that resolves to a task in this set. Tasks with no
 * resolvable primary parent become roots. Any task whose tree-edge does
 * not capture all its dependencies gets a `*` marker so the reader knows
 * to consult the task-index table for the full picture.
 *
 * Sorting is stable: bucket alphabetical, then NN ascending.
 */
export function renderGlobalGraph(allTasks: ParsedTask[]): {
  graph: string;
  hasMultiParent: boolean;
} {
  if (allTasks.length === 0)
    return { graph: "(no tasks)", hasMultiParent: false };

  const sortRefs = (a: ParsedTask, b: ParsedTask) =>
    a.bucket.localeCompare(b.bucket) || a.nn.localeCompare(b.nn);

  const refs = new Set(allTasks.map(refToString));
  const byRef = new Map(allTasks.map((t) => [refToString(t), t] as const));

  // Primary parent = first dep that exists in this task set.
  const primaryParent = new Map<string, string>();
  for (const t of allTasks) {
    for (const dep of t.dependsOn) {
      const depRef = refToString(dep);
      if (refs.has(depRef)) {
        primaryParent.set(refToString(t), depRef);
        break;
      }
    }
  }

  const children = new Map<string, ParsedTask[]>();
  for (const t of allTasks) {
    const parent = primaryParent.get(refToString(t));
    if (!parent) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(t);
  }
  for (const list of children.values()) list.sort(sortRefs);

  const roots = allTasks
    .filter((t) => !primaryParent.has(refToString(t)))
    .sort(sortRefs);

  const lines: string[] = [];
  let hasMultiParent = false;

  const renderSubtree = (
    node: ParsedTask,
    prefix: string,
    visited: Set<string>,
  ) => {
    const ref = refToString(node);
    if (visited.has(ref)) return;
    visited.add(ref);
    const kids = children.get(ref) ?? [];
    kids.forEach((kid, i) => {
      const isLast = i === kids.length - 1;
      const branch = isLast ? "└─→ " : "├─→ ";
      // Tree shows one edge — primary parent → kid. Any other deps the kid
      // has are "extra" relative to that visible edge.
      const extraDeps = kid.dependsOn.length > 1;
      if (extraDeps) hasMultiParent = true;
      lines.push(
        `${prefix}${branch}${refToString(kid)}${extraDeps ? " *" : ""}`,
      );
      const nextPrefix = prefix + (isLast ? "    " : "│   ");
      renderSubtree(kid, nextPrefix, visited);
    });
  };

  for (const root of roots) {
    // A root with any deps at all has deps invisible in the tree (its deps
    // point outside this set or it's a true start). Mark it `*` only when
    // it actually has deps — true starts stay clean.
    const rootHasExtra = root.dependsOn.length > 0;
    if (rootHasExtra) hasMultiParent = true;
    lines.push(`${refToString(root)}${rootHasExtra ? " *" : ""}`);
    renderSubtree(root, "", new Set());
  }

  // Silence unused-variable warning if byRef ever becomes unreferenced
  // during future edits. (No-op at runtime.)
  void byRef;

  return { graph: lines.join("\n"), hasMultiParent };
}

function collectCrossBucket(
  tasks: ParsedTask[],
): { from: string; deps: string[] }[] {
  const out: { from: string; deps: string[] }[] = [];
  for (const t of tasks) {
    const cross = t.dependsOn
      .filter((d) => d.bucket !== t.bucket)
      .map(refToString);
    if (cross.length > 0) {
      out.push({ from: refToString(t), deps: cross });
    }
  }
  return out;
}

/**
 * Splice the generated block into an existing README body. If the markers are
 * present, replace between them; otherwise append the block at the end.
 */
export function spliceGenerated(existing: string, generated: string): string {
  const wrapped = `${GEN_START}\n${generated}\n${GEN_END}`;
  if (existing.includes(GEN_START) && existing.includes(GEN_END)) {
    const before = existing.slice(0, existing.indexOf(GEN_START));
    const after = existing.slice(existing.indexOf(GEN_END) + GEN_END.length);
    return `${before}${wrapped}${after}`;
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${wrapped}\n`;
}

/**
 * Default skeleton for a brand-new README. Mirrors the structure documented in
 * references/readme-template.md so the human-authored sections are already
 * scaffolded — executors only need to fill in the topic-specific bits.
 */
export function defaultSkeleton(topic: string): string {
  return [
    `# ${topic} — Task System`,
    "",
    "## Purpose",
    "",
    "Each task file is a **self-contained, independently pickable unit**. An executor needs only:",
    "",
    "1. The `_context/` files listed in the task's `Required reading` header",
    "2. The task file itself",
    "",
    "They should not need to open `PLAN.md` or any other task file. `PLAN.md` is the master spec; `_context/` is its surgical extract; task files describe **what to do** without re-explaining **why**.",
    "",
    "## Directory layout",
    "",
    "```",
    "tasks/",
    "├── README.md                  ← this file",
    "├── _context/                  ← shared context (every task references these)",
    "│   ├── shared.md              ← decisions, conventions, commit style",
    "│   └── <other>.md             ← topic-specific shared context",
    "└── <bucket>/                  ← bucket description",
    "    └── NN-<slug>.md",
    "```",
    "",
    "## Reading order for executors",
    "",
    "1. `_context/shared.md` — required for every task.",
    "2. Topic-specific `_context/*.md` per the task's `Required reading` header.",
    "3. The task file itself.",
    "",
    "## Naming convention",
    "",
    "`<bucket>/NN-<kebab-slug>.md` — `NN` is two-digit zero-padded.",
    "",
    "## Where to start",
    "",
    "<!-- Edit this with the first task to pick up, e.g. `ui/01-fixture-shell.md`. -->",
    "",
    GEN_START,
    GEN_END,
    "",
    "## Known gaps",
    "",
    "<!-- Human-authored. List unresolved decisions or upstream blockers here. -->",
    "",
  ].join("\n");
}

async function main() {
  const tasksDir = process.argv[2];
  if (!tasksDir) {
    console.error("Usage: bun build-readme.ts <tasks-dir>");
    process.exit(2);
  }

  const readmePath = join(tasksDir, "README.md");
  const { tasks, errors } = await loadTasks(tasksDir);

  if (errors.length > 0) {
    console.error(
      `Cannot build README — ${errors.length} task file(s) have errors:`,
    );
    for (const e of errors) {
      console.error(`  ${e.file}: ${e.reason}`);
    }
    process.exit(1);
  }

  const generated = renderGenerated({ tasks });

  let existing: string;
  try {
    await access(readmePath);
    existing = await readFile(readmePath, "utf-8");
  } catch {
    const topic =
      relative(process.cwd(), tasksDir).split("/").at(-2) ?? "Topic";
    existing = defaultSkeleton(topic);
  }

  const next = spliceGenerated(existing, generated);
  await writeFile(readmePath, next);
  console.log(`Wrote ${readmePath} (${Object.keys(tasks).length} task(s))`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("build-readme error:", err.message);
    process.exit(1);
  });
}
