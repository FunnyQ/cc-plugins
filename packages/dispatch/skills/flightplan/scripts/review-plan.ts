#!/usr/bin/env bun
/**
 * Run a focused Codex review over a flightplan artifact.
 *
 * Reads all plan files (PLAN.md, _context/*.md, tasks/**\/*.md) and passes
 * them as an inline content bundle to `codex review -` (stdin). This scopes
 * the review exactly to the plan tree regardless of other uncommitted changes
 * in the repo.
 *
 * Usage:
 *   bun review-plan.ts docs/<slug>
 *
 * Exits with the codex process exit code so callers can gate on failure.
 *
 * Export surface (for tests):
 *   collectPlanFiles(planDir) — returns ordered list of plan file paths
 *   buildReviewPrompt(files)  — returns the stdin bundle: instructions + file contents
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const REVIEW_INSTRUCTIONS = `
You are reviewing a flightplan artifact — a multi-file planning blueprint written
to disk so a sub-agent can execute each task independently in a later session.

The plan files are embedded below. Review the ENTIRE plan tree for planning
quality. Be sharp — findings should be actionable: name the file, the section
or field, and the concrete fix.

Focus on:

1. Goal consistency — does PLAN.md's stated goal match what the task files actually implement? Flag drift.
2. Acceptance criteria — are they concrete and verifiable, or vague ("should work", "is correct")? Every criterion must be checkable without ambiguity.
3. Task scope — is any single task too large to finish in one session? Flag tasks that mix multiple concerns; suggest a split.
4. Self-containment — can an executor understand each task from _context/ + the task file alone, without opening PLAN.md or sibling tasks?
5. Dependency gaps — are there implicit ordering assumptions not captured in "Depends on:" fields?
6. Eval rubric quality — are rubric dimensions specific to the task, or generic filler? Does the pass threshold make sense for what's being built?
7. Final review completeness — does the final-review task's "Depends on:" field reach every other task in the tree?

Treat every vague acceptance criterion and every cross-file inconsistency as a real defect, not a minor note.

---
`.trim();

export async function collectPlanFiles(planDir: string): Promise<string[]> {
  const files: string[] = [];

  // PLAN.md
  try {
    await stat(join(planDir, "PLAN.md"));
    files.push(join(planDir, "PLAN.md"));
  } catch {
    // skip if missing
  }

  const tasksDir = join(planDir, "tasks");

  // _context files
  try {
    const contextFiles = await readdir(join(tasksDir, "_context"));
    for (const f of contextFiles.sort()) {
      if (f.endsWith(".md")) files.push(join(tasksDir, "_context", f));
    }
  } catch {
    // no _context dir
  }

  // task files across all buckets (excludes README.md)
  try {
    const buckets = await readdir(tasksDir, { withFileTypes: true });
    for (const bucket of buckets.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!bucket.isDirectory() || bucket.name === "_context") continue;
      const bucketDir = join(tasksDir, bucket.name);
      const taskFiles = await readdir(bucketDir);
      for (const f of taskFiles.sort()) {
        if (f.endsWith(".md") && f !== "README.md") {
          files.push(join(bucketDir, f));
        }
      }
    }
  } catch {
    // no tasks dir
  }

  return files;
}

export async function buildReviewPrompt(files: string[]): Promise<string> {
  const sections: string[] = [REVIEW_INSTRUCTIONS, "\n\n# Plan Files\n"];
  for (const f of files) {
    const content = await readFile(f, "utf-8");
    const label = relative(process.cwd(), f);
    sections.push(`\n## ${label}\n\`\`\`markdown\n${content}\n\`\`\``);
  }
  return sections.join("\n");
}

async function main() {
  const planDir = process.argv[2];
  if (!planDir) {
    console.error("Usage: bun review-plan.ts docs/<slug>");
    process.exit(2);
  }

  const files = await collectPlanFiles(planDir);
  if (files.length === 0) {
    console.error(`No plan files found in ${planDir} — run scaffold.ts first`);
    process.exit(1);
  }

  console.log(`Flightplan review — ${files.length} file(s):`);
  for (const f of files) console.log(`  ${relative(process.cwd(), f)}`);
  console.log();

  const prompt = await buildReviewPrompt(files);

  const result = spawnSync("codex", ["review", "-"], {
    input: prompt,
    stdio: ["pipe", "inherit", "inherit"],
    encoding: "utf-8",
  });

  if (result.error) {
    console.warn(
      "codex not found — skipping review (install codex CLI to enable: `codex --version` to verify).\n" +
        "Record this as a Known gap in tasks/README.md and review the plan manually before handing off.",
    );
    process.exit(0);
  }

  process.exit(result.status ?? 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("review-plan error:", err.message);
    process.exit(1);
  });
}
