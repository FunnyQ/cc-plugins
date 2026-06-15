#!/usr/bin/env bun
/**
 * Run a focused review over a flightplan artifact, with a selectable engine.
 *
 * Reads all plan files (PLAN.md, _context/*.md, tasks/**\/*.md) and bundles
 * them (instructions + file contents) for an external reviewer. The bundle
 * scopes the review exactly to the plan tree regardless of other uncommitted
 * changes in the repo.
 *
 * Engines (`--engine`, default `codex`):
 *   codex    — `codex review -` (native review, the inline bundle on stdin).
 *   opencode — delegates to the sibling `opencode-run.ts review` wrapper, which
 *              wraps `opencode run` (opencode has no native review). The bundle is
 *              handed over via `--prompt-file`.
 * The Opus engine is NOT a CLI — it is handled by the flightplan skill, which
 * spawns a fresh independent reviewer subagent. That subagent calls this script
 * with `--print` to obtain the exact same instructions+bundle and reviews it
 * itself, so all three engines share one source of review criteria.
 *
 * Usage:
 *   bun review-plan.ts docs/<slug> [--engine codex|opencode] [--model <m>]
 *   bun review-plan.ts docs/<slug> --print     # emit the instructions+bundle, no CLI
 *
 * Exits with the reviewer's exit code so callers can gate on failure; a missing
 * CLI exits 0 with a warning (skip the gate, record a Known gap).
 *
 * Export surface (for tests):
 *   collectPlanFiles(planDir) — returns ordered list of plan file paths
 *   buildReviewPrompt(files)  — returns the bundle: instructions + file contents
 *   parseArgs(argv)           — pure parse of planDir/engine/model/print
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

export type ReviewEngine = "codex" | "opencode";
export type ReviewArgs = {
  planDir?: string;
  engine: ReviewEngine;
  model?: string;
  print: boolean;
};

/**
 * Parse the CLI argv (pure, for tests). `--engine` defaults to codex; `--print`
 * emits the bundle without invoking any CLI (the Opus subagent path).
 */
export function parseArgs(argv: string[]): ReviewArgs {
  const out: ReviewArgs = { engine: "codex", print: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--engine") {
      const v = argv[++i];
      if (v !== "codex" && v !== "opencode") {
        throw new Error(
          `Unknown --engine: ${v ?? "(missing)"} (expected codex|opencode)`,
        );
      }
      out.engine = v;
    } else if (a === "--model") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value after --model");
      out.model = v;
    } else if (a === "--print") {
      out.print = true;
    } else if (!a.startsWith("--") && out.planDir === undefined) {
      out.planDir = a;
    } else {
      throw new Error(`Unexpected argument: ${a}`);
    }
  }
  return out;
}

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

export function collapseDuplicateReviewOutput(output: string): string {
  const marker = "Full review comments:";
  if (!output.includes(marker)) return output;

  const trimmed = output.trimEnd();
  const trailing = output.slice(trimmed.length);
  const lines = trimmed.split("\n");

  for (let count = Math.floor(lines.length / 2); count > 0; count--) {
    const suffixStart = lines.length - count;
    const previousStart = suffixStart - count;
    let hasMarker = false;
    let matches = true;

    for (let offset = 0; offset < count; offset++) {
      const suffixLine = lines[suffixStart + offset];
      if (suffixLine.includes(marker)) hasMarker = true;
      if (lines[previousStart + offset] !== suffixLine) {
        matches = false;
        break;
      }
    }

    if (hasMarker && matches) {
      return `${lines.slice(0, suffixStart).join("\n")}${trailing}`;
    }
  }

  return output;
}

export function formatCodexReviewOutput(
  stdout: string,
  stderr: string,
): string {
  const output = stdout.trim().length > 0 ? stdout : stderr;
  return collapseDuplicateReviewOutput(output);
}

// codex engine: pipe the inline bundle to codex's native `review` over stdin.
function runCodexReview(prompt: string): number {
  const result = spawnSync("codex", ["review", "-"], {
    input: prompt,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.error) {
    console.warn(
      "codex not found — skipping review (install codex CLI to enable: `codex --version` to verify).\n" +
        "Record this as a Known gap in tasks/README.md and review the plan manually before handing off.",
    );
    return 0;
  }

  const output = formatCodexReviewOutput(result.stdout, result.stderr);
  if (output.length > 0) process.stdout.write(output);
  return result.status ?? 1;
}

// opencode engine: opencode has no native review, so delegate to the sibling
// opencode-run.ts wrapper (it prepends a hard read-only guard, resolves the model,
// and parses opencode's JSONL). The bundle goes over a temp --prompt-file.
function runOpencodeReview(prompt: string, model?: string): number {
  const runner = join(import.meta.dir, "opencode-run.ts");
  const scratch = mkdtempSync(join(tmpdir(), "review-plan-oc-"));
  try {
    const bundleFile = join(scratch, "plan-bundle.md");
    writeFileSync(bundleFile, prompt);
    const args = ["run", runner, "review", "--prompt-file", bundleFile];
    if (model) args.push("--model", model);

    const result = spawnSync("bun", args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });

    const stderr = result.stderr ?? "";
    // Treat a missing/unreachable opencode the same as a missing codex: warn and
    // skip the gate (exit 0) rather than failing the whole plan write.
    if (result.error || stderr.includes("OPENCODE UNREACHABLE")) {
      console.warn(
        "opencode unreachable — skipping review (install opencode CLI to enable: `opencode --version` to verify).\n" +
          "Record this as a Known gap in tasks/README.md and review the plan manually before handing off.",
      );
      return 0;
    }

    if (result.stdout && result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    return result.status ?? 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  let args: ReviewArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(
      "Usage: bun review-plan.ts docs/<slug> [--engine codex|opencode] [--model <m>] [--print]",
    );
    process.exit(2);
  }

  if (!args.planDir) {
    console.error(
      "Usage: bun review-plan.ts docs/<slug> [--engine codex|opencode] [--model <m>] [--print]",
    );
    process.exit(2);
  }

  const files = await collectPlanFiles(args.planDir);
  if (files.length === 0) {
    console.error(
      `No plan files found in ${args.planDir} — run scaffold.ts first`,
    );
    process.exit(1);
  }

  const prompt = await buildReviewPrompt(files);

  // --print: emit the exact instructions+bundle and stop. The Opus reviewer
  // subagent consumes this, so it must be clean (no file-list header on stdout).
  if (args.print) {
    process.stdout.write(prompt);
    process.exit(0);
  }

  console.log(`Flightplan review (${args.engine}) — ${files.length} file(s):`);
  for (const f of files) console.log(`  ${relative(process.cwd(), f)}`);
  console.log();

  const status =
    args.engine === "opencode"
      ? runOpencodeReview(prompt, args.model)
      : runCodexReview(prompt);

  process.exit(status);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("review-plan error:", err.message);
    process.exit(1);
  });
}
