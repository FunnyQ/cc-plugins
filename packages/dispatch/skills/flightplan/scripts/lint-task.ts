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
 *  - Status value is one of todo / in-progress / done / blocked, written bare
 *  - Completion state holds: `done` only with every `## Acceptance criteria`
 *    and `## Verification` checkbox ticked
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
import {
  parseTask,
  refToString,
  taskValidity,
  type ParsedTask,
} from "./lib/parse-task";

export type Violation = {
  file: string;
  rule: string;
  detail: string;
};

// Case-insensitive — catches "PLAN.md", "plan.md", "Plan.md".
const PLAN_REF_REGEX = /\bplan\.md\b/i;
// Sibling-task references: bucket/NN, bucket/NN-slug, bucket/NN-slug.md.
// The lookbehind keeps us off the middle of deeper paths (`src/images/02`,
// `foo-bar/01`) — only a bucket-like token NOT preceded by a path char counts.
const SIBLING_TASK_REGEX =
  /(?<![\w/.-])([a-z][a-z0-9]*)\/(\d{2})(?:-([a-z0-9-]+))?(?:\.md)?\b/g;
// Required reading must be exactly ../_context/<name>.md (sibling _context).
const REQUIRED_READING_REGEX = /^\.\.\/_context\/[a-z0-9_-]+\.md$/;
// Test-runner commands, matched at the head of a backticked span. The trailing
// boundary keeps `bun testify` and `make tested` from counting as a suite.
// It does NOT reject `pytest-cov`: `\b` matches between `t` and `-`, so a
// hyphen-suffixed runner still counts. Left as-is — the false positives are
// all plausible test invocations, and tightening it would reject `go test ./...`.
const TEST_RUNNER_REGEX =
  /^(bun test|(?:npm|pnpm|yarn) (?:run )?test|cargo test|pytest|go test|rspec|make test)\b/;

/**
 * Backticked commands in a task's `## Verification` section that invoke a known
 * test runner. Returns the command strings as written, in document order.
 */
export function testCommandsIn(task: ParsedTask): string[] {
  const section = extractSection(task.body, "Verification");
  if (section === "") return [];

  const lines = section.split("\n");
  const items: string[] = [];
  let currentItem = "";

  for (const line of lines) {
    const isChecklistStart = /^\s*[-*]\s+\[[ x]\]\s/.test(line);
    if (isChecklistStart) {
      if (currentItem) items.push(currentItem);
      currentItem = line;
    } else if (currentItem && line.trim() === "") {
      items.push(currentItem);
      currentItem = "";
    } else if (currentItem && /^\s+\S/.test(line)) {
      currentItem += `\n${line}`;
    }
  }
  if (currentItem) items.push(currentItem);

  const commands: string[] = [];
  for (const item of items) {
    const backtickRegex = /`([^`]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = backtickRegex.exec(item)) !== null) {
      const span = match[1].trim();
      if (TEST_RUNNER_REGEX.test(span)) commands.push(span);
    }
  }
  return commands;
}

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

  // Status + completion state — one shared rule, see taskValidity().
  const validity = taskValidity(task);
  if (validity.kind === "invalid") {
    push(validity.rule, validity.reason);
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
      "body references PLAN.md — task files must be self-contained. Inline whatever the executor needs here (or move it into ../_context/ and list it in Required reading); never point at PLAN.md.",
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
      `body references sibling task file(s): ${[...siblings].join(", ")}. Task files must be self-contained — fix one of two ways: (1) if it's a dependency, it already belongs in the \`Depends on\` header, so delete the inline pointer; (2) if the executor needs that detail, inline it here (or move it into ../_context/). Refer to the thing (the API client, the schema), not the task id.`,
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

  const resolved = resolveFinalReview(tasks);
  if (!resolved) {
    return [
      {
        file: label,
        rule: "final-review",
        detail:
          "no final review task — mark the closing task with `> **Final review**: true` in its header. It must depend (transitively) on every other task so it reviews the whole deliverable.",
      },
    ];
  }
  if (resolved.missing.length > 0) {
    return [
      {
        file: label,
        rule: "final-review",
        detail: `final review task ${refToString(resolved.task)} does not reach all results — its \`Depends on\` is missing: ${resolved.missing.join(", ")}. Add these (directly or transitively) so it reviews the whole deliverable.`,
      },
    ];
  }
  return [];
}

/**
 * The one task both final-review rules judge: the marked task whose transitive
 * `Depends on` closure covers the most of the tree, and a covering one whenever
 * the tree has any. Returns null when no task carries the marker.
 *
 * Both rules resolve through this so a tree carrying more than one marker can
 * never have its coverage judged on one task and its test net on another —
 * which would let the actual closing review ship with no test at all.
 */
export function resolveFinalReview(
  tasks: ParsedTask[],
): { task: ParsedTask; missing: string[] } | null {
  const marked = tasks.filter((t) => t.finalReview);
  if (marked.length === 0) return null;

  const byRef = new Map(tasks.map((t) => [refToString(t), t] as const));

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

  const missingFor = (t: ParsedTask): string[] => {
    const closure = closureOf(t);
    const self = refToString(t);
    return tasks.map(refToString).filter((r) => r !== self && !closure.has(r));
  };

  // Stable sort, so among equally-covering markers the first in document order
  // wins — the same task the old `find` picked.
  return marked
    .map((task) => ({ task, missing: missingFor(task) }))
    .sort((a, b) => a.missing.length - b.missing.length)[0];
}

/**
 * Tree-level check (whole-tree lint only): when the plan has any test commands,
 * the closing final-review task must run one too. This is a presence guarantee
 * only: command strings cannot prove coverage breadth.
 */
export function checkFinalReviewTestNet(
  tasks: ParsedTask[],
  label: string,
): Violation[] {
  if (tasks.length <= 1) return [];

  // One `testCommandsIn` pass over the tree — it re-scans a whole section per
  // call, so the commands are carried alongside their task from here on.
  const withTests = tasks
    .map((task) => ({ task, commands: testCommandsIn(task) }))
    .filter((row) => row.commands.length > 0);
  if (withTests.length === 0) return [];

  const resolved = resolveFinalReview(tasks);
  if (!resolved) return [];
  const marked = resolved.task;
  // Membership is exactly "the closing review runs a test": it is in `withTests`
  // iff it has at least one command.
  if (withTests.some((row) => row.task === marked)) return [];

  const missingFrom = withTests
    .map((row) => `${refToString(row.task)}: ${row.commands.join(", ")}`)
    .join("; ");

  return [
    {
      file: label,
      rule: "final-review-test-net",
      detail: `final-review-test-net: the plan's test suite runs in task(s) ${missingFrom}, but the closing final-review task (${refToString(marked)}) runs no tests. Add a test command to ${refToString(marked)}'s \`## Verification\` section to gate the review's edits.`,
    },
  ];
}

export type TestNetReportRow = {
  ref: string;
  finalReview: boolean;
  commands: string[];
  paths: string[];
};

/**
 * Keep extraction crude because this report is advisory, not a shell parser or
 * a coverage gate.
 */
export function extractTestPaths(command: string): string[] {
  const runner = TEST_RUNNER_REGEX.exec(command);
  if (!runner) return [];

  const tokens = command.split(/\s+/);
  const runnerTokenCount = runner[0].split(/\s+/).length;
  return tokens
    .slice(runnerTokenCount)
    .filter((token) => !token.startsWith("-"));
}

/**
 * Advisory view of which paths each task's test commands touch. One row per task
 * that runs at least one test; the final-review task sorts last so a reader
 * compares the closing gate against the tree above it. Returns [] when no task
 * in the tree runs a test at all.
 */
export function testNetReport(tasks: ParsedTask[]): TestNetReportRow[] {
  // Describe the detected command strings only; advisory reach never becomes a gate.
  return tasks
    .map((task) => {
      const commands = testCommandsIn(task);
      return {
        ref: refToString(task),
        finalReview: task.finalReview,
        commands,
        paths: commands.flatMap(extractTestPaths),
      };
    })
    .filter((row) => row.commands.length > 0)
    .sort((a, b) => Number(a.finalReview) - Number(b.finalReview));
}

/** Render the rows as an indented, human-scannable block. Pure. */
export function formatTestNetReport(rows: TestNetReportRow[]): string {
  const lines = ["Test net report:"];
  for (const row of rows) {
    const label = row.finalReview ? " [final review]" : "";
    lines.push(`  ${row.ref}${label}`);
    lines.push(`    commands: ${row.commands.join(", ")}`);
    lines.push(
      `    paths: ${row.paths.length > 0 ? row.paths.join(", ") : "(all)"}`,
    );
  }
  return lines.join("\n");
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
    reportAll(checkFinalReviewTestNet(parsed, treeRoots[0]));
    const rows = testNetReport(parsed);
    // Keep this on stdout and before exit: it cannot affect total or disappear on failure.
    if (rows.length > 0) console.log(formatTestNetReport(rows));
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
