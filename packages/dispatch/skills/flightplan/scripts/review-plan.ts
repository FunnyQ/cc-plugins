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
 *   bun review-plan.ts docs/<slug> --prior-findings <file>   # round 2+
 *   bun review-plan.ts docs/<slug> --narrow --prior-passes 8 # the post-cap phase
 *   bun review-plan.ts docs/<slug> --print     # emit the instructions+bundle, no CLI
 *
 * Two instruction sets, one per phase, both baked in here so all three engines
 * share one source of criteria: the broad one (7 checks, P1+P2) for the main
 * loop, and the narrow one (`--narrow`, blocking classes only, at most five
 * findings) for the phase Step 7 enters after the broad loop hits its cap.
 *
 * Exits with the reviewer's exit code so callers can gate on failure; a missing
 * CLI exits 0 with a warning (skip the gate, record a Known gap).
 *
 * Export surface (for tests):
 *   collectPlanFiles(planDir) — returns ordered list of plan file paths
 *   buildReviewPrompt(files, prior?, opts?) — the bundle: instructions + prior
 *                                      findings + file contents
 *   narrowInstructions(n?)    — the narrow-phase instruction text
 *   parseArgs(argv)           — pure parse of planDir/engine/model/print/prior/narrow
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type ReviewEngine = "codex" | "opencode";
export type ReviewArgs = {
  planDir?: string;
  engine: ReviewEngine;
  model?: string;
  print: boolean;
  priorFindings?: string;
  narrow: boolean;
  priorPasses?: number;
};

/**
 * Parse the CLI argv (pure, for tests). `--engine` defaults to codex; `--print`
 * emits the bundle without invoking any CLI (the Opus subagent path).
 */
export function parseArgs(argv: string[]): ReviewArgs {
  const out: ReviewArgs = { engine: "codex", print: false, narrow: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--narrow") {
      out.narrow = true;
    } else if (a === "--prior-passes") {
      const v = argv[++i];
      const n = Number(v);
      if (!v || !Number.isInteger(n) || n < 1) {
        throw new Error(
          `--prior-passes needs a positive integer, got: ${v ?? "(missing)"}`,
        );
      }
      out.priorPasses = n;
    } else if (a === "--engine") {
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
    } else if (a === "--prior-findings") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value after --prior-findings");
      out.priorFindings = v;
    } else if (a === "--print") {
      out.print = true;
    } else if (!a.startsWith("--") && out.planDir === undefined) {
      out.planDir = a;
    } else {
      throw new Error(`Unexpected argument: ${a}`);
    }
  }
  // A pass count with no narrow phase is a typo, not a preference: the broad
  // instructions have nowhere to put it, so honoring it silently would run the
  // wrong prompt for a caller who believes they asked for the narrow one.
  if (out.priorPasses !== undefined && !out.narrow) {
    throw new Error("--prior-passes requires --narrow");
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

Two things in the bundle are NOT under review:

- The task index in \`tasks/README.md\` sits between generated markers and is rewritten by a script from the task headers. Report nothing inside it.
- A "## Known gaps" entry — in \`tasks/README.md\` or in PLAN.md — is the author's dispositioned decision: a defect they already saw and chose to accept. Never report one as P1. Raise it as P2 only when you can name a consequence the author's own note does not cover.

Treat every vague acceptance criterion and every cross-file inconsistency as a real defect, not a minor note.

Label every finding P1 or P2 as the first token of its line, because the caller
loops until no P1 remains:

- P1 — an executor hits this and stalls or guesses: a missing or contradicted decision, two files that disagree, an unverifiable acceptance criterion, a dependency edge that cannot be satisfied, a task that cannot be done from _context/ plus its own file.
- P2 — an executor ships anyway: wording, ordering, a criterion that could be sharper, a task that could split more cleanly.

Do not inflate P2 into P1 to seem thorough, and do not soften a P1 to seem agreeable. If the plan is clean, say so and return no findings.

---
`.trim();

// The narrow phase (`--narrow`), which Step 7 enters when the broad loop hits
// its cap with P1s still open. It does NOT lower the bar: its five qualifying
// classes are the broad P1 definition restated. What it removes is the padding
// pressure — the P2 channel, the open-ended finding count, and the absence of a
// sanctioned clean verdict. A broad prompt run against an already-revised plan
// manufactures findings and files some of them as P1; the broad text tries to
// stop that with one sentence ("Do not inflate P2 into P1"), which does not
// hold past a handful of passes. This is the same criteria, aimed only at what
// blocks.
export function narrowInstructions(priorPasses?: number): string {
  const history =
    priorPasses !== undefined
      ? `has already been through ${priorPasses} review passes`
      : `has already been through a full review cycle`;
  return `
You are reviewing a flightplan artifact — a multi-file planning blueprint written
to disk so a sub-agent can execute each task independently in a later session,
with no access to this conversation.

This plan ${history}. The loud problems are fixed. Your job is NOT to find more
things that could be sharper — it is to find the ones that would actually **stop
an executor or make them produce the wrong thing**.

## Report a finding only if it meets this bar

A finding qualifies only when an executor, opening one task file plus the \`_context/\`
files it lists, would either **stall** or **confidently produce something wrong**.
Concretely, that is:

1. **Two files that contradict each other** on a decision the executor must act on — a flag, a type, a path, a default, a required behavior. Name both sides.
2. **An interface a task depends on that no task defines** — a function, struct, enum variant, or field that is used but never specified, where the executor would have to invent it and a sibling task would then collide with their invention.
3. **A dependency that cannot be satisfied** — a task that needs an artifact produced by a task that runs after it, or not at all.
4. **An acceptance criterion that is impossible to satisfy, or that passes while the stated goal fails** — an arithmetic impossibility, a criterion referencing something that does not exist at that point in the sequence, or a gate that a deliberately-broken implementation would still pass.
5. **A task that cannot be done from \`_context/\` plus its own file** — genuinely missing substance, not a preference for more detail.

## Do NOT report these

These were considered and are out of scope for this pass. Reporting them is noise:

- Wording, ordering, phrasing, or a criterion that "could be sharper" while still being checkable.
- A missing test case, a missing golden fixture, or a fixture count — unless the count makes a stated criterion arithmetically impossible.
- A rubric anchor you would have written differently.
- Anything explicitly recorded as a deliberate limitation, deferral, or "out of scope" in the file itself — those are decisions. Only flag one if you can name a concrete failure the author's own stated reason does not cover.
- A \`## Known gaps\` entry in \`tasks/README.md\` or PLAN.md — same rule: those are dispositioned decisions.
- The task index in \`tasks/README.md\` between the generated markers — it is machine-written from task headers.
- Suggestions to add scope, options, flags, or capabilities. The plan's surface is itself a decision; "you should also support X" is not a defect.

## Output

Rank findings by how badly they block, worst first. **Report at most five.** Prefix each with \`P1\`.

If nothing meets the bar, say exactly: \`No blocking findings.\` — and stop. Do not pad the list to appear thorough. A clean verdict on an already-revised plan is a legitimate and expected outcome.

For each finding give: the file, the section or field, what the two sides say (or what is missing), and the concrete fix in one sentence.

---
`.trim();
}

// Every finding the author dispositioned instead of fixing is banked in
// tasks/README.md's "Known gaps". A reviewer that cannot see it re-files the
// same finding as P1 every pass, and the loop — which exits only on a P1-clean
// pass — never converges. So the file ships in the bundle, right after PLAN.md,
// where the reviewer reads the intent before the tree. Bucket-level READMEs
// stay excluded: they are not task content.
const PRIOR_FINDINGS_RULE = `
# Findings already reported

An earlier pass over a previous revision of this plan reported the findings
below, and the author has since acted on them. Report one of them again ONLY
when the current files still show that defect — and then say what the fix
missed. Anything the author banked as a Known gap is a decision, not an
unfixed defect. Rank findings NEW to this pass above repeats.
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

  // tasks/README.md — carries the Known gaps the reviewer must not re-raise
  try {
    await stat(join(tasksDir, "README.md"));
    files.push(join(tasksDir, "README.md"));
  } catch {
    // skip if missing
  }

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

export async function buildReviewPrompt(
  files: string[],
  priorFindings?: string,
  opts?: { narrow?: boolean; priorPasses?: number },
): Promise<string> {
  const sections: string[] = [
    opts?.narrow ? narrowInstructions(opts.priorPasses) : REVIEW_INSTRUCTIONS,
  ];
  if (priorFindings && priorFindings.trim().length > 0) {
    sections.push(`\n\n${PRIOR_FINDINGS_RULE}\n\n${priorFindings.trim()}\n`);
  }
  sections.push("\n\n# Plan Files\n");
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
      "Usage: bun review-plan.ts docs/<slug> [--engine codex|opencode] [--model <m>] [--prior-findings <file>] [--narrow [--prior-passes <n>]] [--print]",
    );
    process.exit(2);
  }

  if (!args.planDir) {
    console.error(
      "Usage: bun review-plan.ts docs/<slug> [--engine codex|opencode] [--model <m>] [--prior-findings <file>] [--narrow [--prior-passes <n>]] [--print]",
    );
    process.exit(2);
  }

  const files = await collectPlanFiles(args.planDir);
  if (files.length === 0) {
    // Exit 2, not 1. This script's exit code mirrors the reviewer's verdict, so
    // a 1 here is indistinguishable from "the reviewer found blocking issues" —
    // a caller looping on the exit code reads a wrong cwd as a failed review and
    // starts fixing a tree that was never opened.
    console.error(
      `No plan files found in ${resolve(args.planDir)} — run scaffold.ts first.` +
        `\nWorking directory: ${process.cwd()}`,
    );
    process.exit(2);
  }

  // A prior-findings path that cannot be read is a hard error, never a silent
  // fall-back to a first-round bundle: the reviewer would re-file every already
  // dispositioned finding as P1 and the caller would loop on it again.
  let prior: string | undefined;
  if (args.priorFindings) {
    try {
      prior = await readFile(args.priorFindings, "utf-8");
    } catch (err) {
      console.error(
        `Cannot read --prior-findings ${args.priorFindings}: ${(err as Error).message}`,
      );
      process.exit(2);
    }
  }

  const prompt = await buildReviewPrompt(files, prior, {
    narrow: args.narrow,
    priorPasses: args.priorPasses,
  });

  // --print: emit the exact instructions+bundle and stop. The Opus reviewer
  // subagent consumes this, so it must be clean (no file-list header on stdout).
  if (args.print) {
    process.stdout.write(prompt);
    process.exit(0);
  }

  console.log(
    `Flightplan review (${args.engine}${args.narrow ? ", narrow" : ""}) — ${files.length} file(s):`,
  );
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
