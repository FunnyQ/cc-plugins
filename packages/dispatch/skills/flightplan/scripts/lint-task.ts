#!/usr/bin/env bun
/**
 * Lint flightplan task files.
 *
 * Accepts either a tasks/ directory (preferred — same interface as
 * build-readme.ts and next-ready.ts), or individual task files. When given a
 * directory, the script auto-skips `_context/` and `README.md` so the LLM
 * doesn't have to worry about which sub-paths to include.
 *
 * Verifies for every task file:
 *  - H1 has shape "# BUCKET-NN: Title", and BUCKET-NN matches the file path
 *  - Required reading paths are sibling `../_context/<name>.md` and resolve
 *  - Status value is one of todo / in-progress / done / blocked
 *  - Body does not reference PLAN.md (any casing) or sibling task files
 *    (`bucket/NN`, `bucket/NN-slug`, `bucket/NN-slug.md` — own file excluded)
 *  - Has `## Acceptance criteria` with at least one checkbox in that section
 *  - Has `## Verification` section
 *  - Has a parseable `## Eval rubric` (pass-threshold line + weighted table),
 *    with the threshold inside the scale (strict — every task must score)
 *
 * Usage:
 *   bun lint-task.ts <tasks-dir>             # recommended
 *   bun lint-task.ts <file>...               # cherry-pick
 *
 * Exits 0 if all files pass; 1 if any violation is found.
 */
import { readFile, access, stat, readdir } from "node:fs/promises";
import { basename, dirname, resolve, relative, sep } from "node:path";
import { parseTask, refToString, type ParsedTask } from "./lib/parse-task";

export type Violation = {
  file: string;
  rule: string;
  detail: string;
};

// Case-insensitive — catches "PLAN.md", "plan.md", "Plan.md".
const PLAN_REF_REGEX = /\bplan\.md\b/i;
// Sibling-task references: bucket/NN, bucket/NN-slug, bucket/NN-slug.md.
const SIBLING_TASK_REGEX =
  /\b([a-z][a-z0-9]*)\/(\d{2})(?:-([a-z0-9-]+))?(?:\.md)?\b/g;
// Required reading must be exactly ../_context/<name>.md (sibling _context).
const REQUIRED_READING_REGEX = /^\.\.\/_context\/[a-z0-9_-]+\.md$/;

export async function lintFile(filePath: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const push = (rule: string, detail: string) =>
    violations.push({ file: filePath, rule, detail });

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    push("read", `cannot read file: ${(err as Error).message}`);
    return violations;
  }

  const parsed = parseTask(content);
  if (!parsed.ok) {
    push("parse", parsed.reason);
    return violations;
  }
  const task = parsed.task;

  // Path vs H1 — the H1 claim must match where the file lives.
  const pathInfo = inferRefFromPath(filePath);
  if (pathInfo) {
    if (pathInfo.bucket !== task.bucket || pathInfo.nn !== task.nn) {
      push(
        "h1-path-mismatch",
        `H1 says ${task.bucket}/${task.nn} but file path implies ${pathInfo.bucket}/${pathInfo.nn}`,
      );
    }
  }

  // Status
  if (task.status === null) {
    push(
      "status",
      "Status missing or not one of todo/in-progress/done/blocked",
    );
  }

  // Required reading — exact shape ../_context/<name>.md and resolvable.
  if (task.requiredReading.length === 0) {
    push("required-reading", "no Required reading paths listed");
  } else {
    for (const ref of task.requiredReading) {
      if (!REQUIRED_READING_REGEX.test(ref)) {
        push(
          "required-reading",
          `path "${ref}" must be exactly ../_context/<name>.md (sibling _context/)`,
        );
        continue;
      }
      const abs = resolve(dirname(filePath), ref);
      try {
        const s = await stat(abs);
        if (!s.isFile()) {
          push(
            "required-reading",
            `path "${ref}" resolves to a non-file at ${abs}`,
          );
        }
      } catch {
        push(
          "required-reading",
          `path "${ref}" does not resolve from ${filePath}`,
        );
      }
    }
  }

  // Self-containment: body must not reference PLAN.md or sibling task files.
  if (PLAN_REF_REGEX.test(task.body)) {
    push(
      "self-containment",
      "body references PLAN.md — task files must be self-contained",
    );
  }
  const ownRef = `${task.bucket}/${task.nn}`;
  const ownBase = basename(filePath, ".md");
  const ownRefSlug = `${task.bucket}/${ownBase}`;
  const siblings = new Set<string>();
  let m: RegExpExecArray | null;
  SIBLING_TASK_REGEX.lastIndex = 0;
  while ((m = SIBLING_TASK_REGEX.exec(task.body)) !== null) {
    const fullMatch = m[0].replace(/\.md$/, "");
    // Skip if it's referring to itself in any form.
    if (fullMatch === ownRef || fullMatch === ownRefSlug) continue;
    siblings.add(m[0]);
  }
  if (siblings.size > 0) {
    push(
      "self-containment",
      `body references sibling task file(s): ${[...siblings].join(", ")}`,
    );
  }

  // Required sections
  const sectionSet = new Set(task.sections);
  if (!sectionSet.has("Acceptance criteria")) {
    push("sections", "missing `## Acceptance criteria` section");
  } else {
    const acSection = extractSection(task.body, "Acceptance criteria");
    if (!/- \[[ x]\]/.test(acSection)) {
      push(
        "sections",
        "Acceptance criteria has no checkbox items (`- [ ] ...`)",
      );
    }
  }
  if (!sectionSet.has("Verification")) {
    push("sections", "missing `## Verification` section");
  }

  // Eval rubric — mandatory and machine-parseable (strict). Acceptance criteria
  // is the binary gate; the rubric is the graded quality score on top of it.
  if (!sectionSet.has("Eval rubric")) {
    push(
      "rubric",
      "missing `## Eval rubric` section — every task must carry a graded rubric (see references/task-template.md)",
    );
  } else if (task.rubric === null) {
    push(
      "rubric",
      "`## Eval rubric` is present but unparseable — need a `>`-quoted pass line (e.g. `weighted average > 4.0 to pass`) and a weighted dimension table (`| Dimension | Weight | … |` with `×N` weights)",
    );
  } else if (
    task.rubric.passThreshold <= 0 ||
    task.rubric.passThreshold > task.rubric.scaleMax
  ) {
    push(
      "rubric",
      `pass threshold ${task.rubric.passThreshold} is out of the 0–${task.rubric.scaleMax} scale`,
    );
  }

  return violations;
}

/**
 * Tree-level check (whole-tree lint only): the plan must have a declared final
 * review that gates the whole deliverable. Two conditions, together:
 *
 *   1. **marker** — at least one task carries `> **Final review**: true`.
 *   2. **coverage** — one such marked task's transitive `Depends on` closure
 *      reaches every other task, so the review can't start until all the work
 *      is done and it sees the whole deliverable.
 *
 * The marker says "this is the review" (not just a task that happens to be
 * terminal); coverage proves it actually reviews all results. Plans with one
 * task are exempt (nothing to gate). Naming-agnostic — reads the marker + graph,
 * not bucket names.
 */
export function checkFinalReview(
  tasks: ParsedTask[],
  label: string,
): Violation[] {
  if (tasks.length <= 1) return [];

  const ref = (t: ParsedTask) => `${t.bucket}/${t.nn}`;
  const byRef = new Map(tasks.map((t) => [ref(t), t] as const));

  // Transitive dependency closure of a task (cycle-safe).
  const closureOf = (t: ParsedTask): Set<string> => {
    const seen = new Set<string>();
    const stack = t.dependsOn.map(refToString);
    while (stack.length > 0) {
      const r = stack.pop()!;
      if (seen.has(r)) continue;
      seen.add(r);
      const dep = byRef.get(r);
      if (dep) stack.push(...dep.dependsOn.map(refToString));
    }
    return seen;
  };

  const marked = tasks.filter((t) => t.finalReview);
  if (marked.length === 0) {
    return [
      {
        file: label,
        rule: "final-review",
        detail:
          "no final review task — mark the closing task with `> **Final review**: true` in its header. It must depend (transitively) on every other task so it reviews the whole deliverable.",
      },
    ];
  }

  // At least one marked task must cover everything else.
  const missingFor = (t: ParsedTask): string[] => {
    const closure = closureOf(t);
    return tasks.map(ref).filter((r) => r !== ref(t) && !closure.has(r));
  };
  const covering = marked.find((t) => missingFor(t).length === 0);
  if (!covering) {
    // Report the marked task that comes closest, with what it misses.
    const best = marked
      .map((t) => ({ t, missing: missingFor(t) }))
      .sort((a, b) => a.missing.length - b.missing.length)[0];
    return [
      {
        file: label,
        rule: "final-review",
        detail: `final review task ${ref(best.t)} does not reach all results — its \`Depends on\` is missing: ${best.missing.join(", ")}. Add these (directly or transitively) so it reviews the whole deliverable.`,
      },
    ];
  }
  return [];
}

/** Derive bucket + NN from a path like `.../tasks/ui/01-foo.md`. */
export function inferRefFromPath(
  filePath: string,
): { bucket: string; nn: string } | null {
  const parts = filePath.split(sep);
  const fileName = parts.at(-1) ?? "";
  const bucket = parts.at(-2) ?? "";
  const match = /^(\d{2})-/.exec(fileName);
  if (!match || !/^[a-z][a-z0-9]*$/.test(bucket)) return null;
  return { bucket, nn: match[1] };
}

/** Return the lines of body that belong to a given `## Heading` section. */
function extractSection(body: string, heading: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex(
    (l) => l.trim() === `## ${heading}` || l.trim().startsWith(`## ${heading}`),
  );
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** Collect task-file paths under a tasks/ dir, skipping _context/ and README. */
export async function collectTaskFiles(tasksDir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(tasksDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "_context") continue;
    const bucketDir = resolve(tasksDir, entry.name);
    for (const file of await readdir(bucketDir)) {
      if (!file.endsWith(".md")) continue;
      if (file === "README.md") continue;
      out.push(resolve(bucketDir, file));
    }
  }
  return out;
}

async function resolveInputs(
  args: string[],
): Promise<{ files: string[]; treeRoots: string[] }> {
  const files: string[] = [];
  const treeRoots: string[] = [];
  for (const arg of args) {
    let info;
    try {
      info = await stat(arg);
    } catch {
      // Treat as a missing path — main() will surface read errors per-file.
      files.push(arg);
      continue;
    }
    if (info.isDirectory()) {
      treeRoots.push(arg);
      files.push(...(await collectTaskFiles(arg)));
    } else {
      files.push(arg);
    }
  }
  return { files, treeRoots };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: bun lint-task.ts <tasks-dir | file>...");
    process.exit(2);
  }

  const { files, treeRoots } = await resolveInputs(args);
  if (files.length === 0) {
    console.error("No task files found.");
    process.exit(2);
  }

  let total = 0;
  const reportAll = (violations: Violation[]) => {
    for (const v of violations) {
      const rel = relative(process.cwd(), v.file) || v.file;
      console.error(`${rel}  [${v.rule}] ${v.detail}`);
    }
    total += violations.length;
  };

  const parsed: ParsedTask[] = [];
  for (const file of files) {
    reportAll(await lintFile(file));
    // Collect parsed tasks for the tree-level pass below.
    try {
      const p = parseTask(await readFile(file, "utf-8"));
      if (p.ok) parsed.push(p.task);
    } catch {
      /* per-file read errors already reported by lintFile */
    }
  }

  // Tree-level checks only run when a tasks/ directory was given (whole-tree
  // mode) — a cherry-picked file list is too partial to judge the final gate.
  if (treeRoots.length > 0) {
    reportAll(checkFinalReview(parsed, treeRoots[0]));
  }

  if (total > 0) {
    console.error(`\n${total} violation(s) in ${files.length} file(s).`);
    process.exit(1);
  }
  console.log(`All ${files.length} task file(s) pass.`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("lint-task error:", err.message);
    process.exit(2);
  });
}
