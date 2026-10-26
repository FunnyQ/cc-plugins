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
 * Claude reviewers (the Opus engine, and the sonnet lens subagents) are NOT a
 * CLI — the flightplan skill spawns them, and they call this script with
 * `--print` to obtain the exact same instructions+bundle, so every engine shares
 * one source of review criteria.
 *
 * Usage:
 *   bun review-plan.ts docs/<slug> --lens <lens> [--scope design|tree] [--engine codex|opencode] [--model <m>]
 *   bun review-plan.ts docs/<slug> --lens <lens> --prior-findings <file>   # pass 2+
 *   bun review-plan.ts docs/<slug> --narrow --prior-passes 8 # the post-cap phase
 *   bun review-plan.ts docs/<slug> --lens <lens> --print     # emit the instructions+bundle, no CLI
 *
 * Instruction sets: one per lens (sim-instructor, navigator, check-airman,
 * tower — P1+P2, each limited to its own concerns) for the design and tree
 * gates, and the narrow one (`--narrow`, blocking classes only, at most five
 * findings) for the phase Step 7 enters after the tree gate hits its cap.
 * `--scope design` bundles PLAN.md and _context/ only, for the gate that runs
 * before the task files are written.
 *
 * Exits with the reviewer's exit code so callers can gate on failure; a missing
 * CLI exits 0 with a warning (skip the gate, record a Known gap).
 *
 * Export surface (for tests):
 *   collectPlanFiles(planDir, scope?) — returns ordered list of plan file paths
 *   buildReviewPrompt(files, prior, opts) — the bundle: instructions + prior
 *                                      findings + file contents
 *   lensInstructions(lens, scope) — one lens's instruction text
 *   narrowInstructions(n?)    — the narrow-phase instruction text
 *   parseArgs(argv)           — pure parse of planDir/engine/model/print/prior/narrow/lens/scope
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type ReviewEngine = "codex" | "opencode";
export type ReviewLens =
  "sim-instructor" | "navigator" | "check-airman" | "tower";
export type ReviewScope = "design" | "tree";
const LENS_NAMES: ReviewLens[] = [
  "sim-instructor",
  "navigator",
  "check-airman",
  "tower",
];
export type ReviewArgs = {
  planDir?: string;
  engine: ReviewEngine;
  model?: string;
  print: boolean;
  priorFindings?: string;
  narrow: boolean;
  priorPasses?: number;
  lens?: ReviewLens;
  scope: ReviewScope;
};

export function parseArgs(argv: string[]): ReviewArgs {
  const out: ReviewArgs = {
    engine: "codex",
    print: false,
    narrow: false,
    scope: "tree",
  };
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
    } else if (a === "--lens") {
      const v = argv[++i];
      if (!LENS_NAMES.includes(v as ReviewLens)) {
        throw new Error(
          `Unknown --lens: ${v ?? "(missing)"} (expected ${LENS_NAMES.join("|")})`,
        );
      }
      out.lens = v as ReviewLens;
    } else if (a === "--scope") {
      const v = argv[++i];
      if (v !== "design" && v !== "tree") {
        throw new Error(
          `Unknown --scope: ${v ?? "(missing)"} (expected design|tree)`,
        );
      }
      out.scope = v;
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
      if (!v || v.startsWith("--")) throw new Error("Missing value after --model");
      out.model = v;
    } else if (a === "--prior-findings") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("Missing value after --prior-findings");
      out.priorFindings = v;
    } else if (a === "--print") {
      out.print = true;
    } else if (!a.startsWith("--") && out.planDir === undefined) {
      out.planDir = a;
    } else {
      throw new Error(`Unexpected argument: ${a}`);
    }
  }
  if (out.priorPasses !== undefined && !out.narrow) {
    throw new Error("--prior-passes requires --narrow");
  }
  if (out.narrow && out.lens) {
    throw new Error(
      "--narrow takes no --lens: the narrow phase is one unified prompt",
    );
  }
  if (out.narrow && out.scope === "design") {
    throw new Error("--narrow reviews the whole tree; drop --scope design");
  }
  if (!out.narrow && !out.lens) {
    throw new Error(
      `--lens is required (${LENS_NAMES.join("|")}), or pass --narrow`,
    );
  }
  return out;
}

const LENS_TITLES: Record<ReviewLens, string> = {
  "sim-instructor": "Sim Instructor",
  navigator: "Navigator",
  "check-airman": "Check Airman",
  tower: "Tower",
};

const LENS_CRITERIA: Record<ReviewLens, string> = {
  "sim-instructor": `
You inject failures before anything flies. Find where the planned design breaks
in the real environment:

1. Concurrency and ordering — races, re-entrancy, two runs overlapping, results that arrive late or out of order, a timeout that fires while work is still in flight.
2. Lifecycle and ownership — state cleared by a party that does not own it, a resource that dies before its user or outlives it, a cleanup path that skips a case.
3. Security boundaries — allow-lists and path prefixes, an empty or missing value (an empty root prefix matches every path), encoded traversal, quoting and spaces in paths, untrusted content reaching a privileged sink.
4. Platform and engine constraints — time budgets, API limits, sandbox rules, what the runtime actually allows. Read the real code and type definitions the plan names; report a constraint only when you can cite the file that states it.

For each hazard, name the concrete input or sequence of events that triggers it.
`,
  navigator: `
You check the plan is still heading where it says it is going:

1. Goal against decisions — every decision serves the stated goal, and no decision makes the goal unreachable.
2. Goal against non-goals — no decision builds something the Non-goals exclude, and no Non-goal removes something the goal needs.
3. Claims — every promise the plan makes (privacy, cost, performance, compatibility, "sends nothing", "loads nothing") is true of the mechanism it describes. Name the mechanism that contradicts the claim.
4. Numbers and limits — a cap, count, or retention rule matches every other place that states it.
5. At tree scope, the task files together implement the goal: flag drift between what PLAN.md promises and what the tasks build.
`,
  "check-airman": `
You check that every gate actually checks. For every \`## Verification\` command
and every \`## Acceptance criteria\` item, run two thought experiments:

1. A correct implementation — would it pass? Flag a check that cannot pass: malformed shell (\`grep -c\` asked to print content, an unquoted placeholder), a pattern that also matches legitimate content (tests, fixtures, a namespace URL), a wrong expected value, a check that forbids an edit the task itself requires.
2. A deliberately broken implementation — would it fail? Flag a criterion loose enough to pass a regression: "not 404" that also accepts a 500, "behaves as before" with no recorded baseline.
3. Checks no command can make must be tagged \`(human)\`, and a human check still needs a fixed sample and a pass condition.
4. Eval rubric quality — dimensions specific to the task, a pass threshold that makes sense for what is built.

Quote the command or criterion, and name the implementation that breaks it.
`,
  tower: `
You hold every file to every other file:

1. Contradictions — two files disagreeing on a name, type, path, default, flag, or required behavior. Name both sides.
2. Propagation — a renamed symbol or changed decision that some file still states the old way. Search the bundle for the old term.
3. Ownership and order — a task whose check needs work a later task does, or a task that edits a file another task owns.
4. Dependencies — an ordering assumption missing from "Depends on:", and a Final review task whose "Depends on:" does not reach every other task.
5. Self-containment — each task can be done from _context/ plus its own file, without PLAN.md or a sibling task.
6. Task scope — a task too large for one session, or one that mixes concerns; suggest the split.
`,
};

const DESIGN_SCOPE_NOTE = `
This is the design review. Only PLAN.md and the _context/ files exist; the task
files are written from them after this review passes.
Do not report missing task files, verification commands, or rubrics.
`.trim();

const SHARED_RULES = `
Three other lenses review this plan in parallel, each for its own concerns.
Report only findings inside your lens; a finding outside it is noise here. Make
each finding actionable: name the file, the section or field, and the concrete fix.

Two things in the bundle are NOT under review:

- The task index in \`tasks/README.md\` sits between generated markers and is rewritten by a script from the task headers. Report nothing inside it.
- A "## Known gaps" entry — in \`tasks/README.md\` or in PLAN.md — is the author's dispositioned decision: a defect they already saw and chose to accept. Never report one as P1. Raise it as P2 only when you can name a consequence the author's own note does not cover.

Label every finding P1 or P2 as the first token of its line, because the caller
loops until no P1 remains:

- P1 — an executor hits this and stalls or guesses: a missing or contradicted decision, two files that disagree, an unverifiable acceptance criterion, a dependency edge that cannot be satisfied, a task that cannot be done from _context/ plus its own file.
- P2 — an executor ships anyway: wording, ordering, a criterion that could be sharper, a task that could split more cleanly.

Do not inflate P2 into P1 to seem thorough, and do not soften a P1 to seem agreeable. If the plan is clean inside your lens, say so and return no findings.
`.trim();

export function lensInstructions(lens: ReviewLens, scope: ReviewScope): string {
  const sections = [
    `You are reviewing a flightplan artifact — a multi-file planning blueprint written
to disk so a sub-agent can execute each task independently in a later session.
The plan files are embedded below.`,
    `# Your lens: ${LENS_TITLES[lens]}\n\n${LENS_CRITERIA[lens].trim()}`,
  ];
  if (scope === "design") sections.push(DESIGN_SCOPE_NOTE);
  sections.push(SHARED_RULES, "---");
  return sections.join("\n\n");
}

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

const PLACEHOLDER_PREMISE = `
Note: \`<baseRef>\` is a placeholder that autopilot substitutes with
the commit the run started from, so it is defined. Do not report it as undefined.
`.trim();

const PRIOR_FINDINGS_RULE = `
# Findings already reported

An earlier pass over a previous revision of this plan reported the findings
below, and the author has since acted on them. Report one of them again ONLY
when the current files still show that defect — and then say what the fix
missed. Anything the author banked as a Known gap is a decision, not an
unfixed defect. Rank findings NEW to this pass above repeats.
`.trim();

export async function collectPlanFiles(
  planDir: string,
  scope: ReviewScope = "tree",
): Promise<string[]> {
  const files: string[] = [];

  try {
    await stat(join(planDir, "PLAN.md"));
    files.push(join(planDir, "PLAN.md"));
  } catch {}

  const tasksDir = join(planDir, "tasks");

  if (scope === "tree") {
    try {
      await stat(join(tasksDir, "README.md"));
      files.push(join(tasksDir, "README.md"));
    } catch {}
  }

  try {
    const contextFiles = await readdir(join(tasksDir, "_context"));
    for (const f of contextFiles.sort()) {
      if (f.endsWith(".md")) files.push(join(tasksDir, "_context", f));
    }
  } catch {}

  if (scope === "design") return files;

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
  } catch {}

  return files;
}

export async function buildReviewPrompt(
  files: string[],
  priorFindings: string | undefined,
  opts:
    | { lens: ReviewLens; scope?: ReviewScope }
    | { narrow: true; priorPasses?: number },
): Promise<string> {
  const sections: string[] = [
    "narrow" in opts
      ? narrowInstructions(opts.priorPasses)
      : lensInstructions(opts.lens, opts.scope ?? "tree"),
    `\n\n${PLACEHOLDER_PREMISE}`,
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
      "Usage: bun review-plan.ts docs/<slug> (--lens sim-instructor|navigator|check-airman|tower [--scope design|tree] | --narrow [--prior-passes <n>]) [--engine codex|opencode] [--model <m>] [--prior-findings <file>] [--print]",
    );
    process.exit(2);
  }

  if (!args.planDir) {
    console.error(
      "Usage: bun review-plan.ts docs/<slug> (--lens sim-instructor|navigator|check-airman|tower [--scope design|tree] | --narrow [--prior-passes <n>]) [--engine codex|opencode] [--model <m>] [--prior-findings <file>] [--print]",
    );
    process.exit(2);
  }

  const files = await collectPlanFiles(args.planDir, args.scope);
  if (files.length === 0) {
    console.error(
      `No plan files found in ${resolve(args.planDir)} — run scaffold.ts first.` +
        `\nWorking directory: ${process.cwd()}`,
    );
    process.exit(2);
  }

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

  const prompt = await buildReviewPrompt(
    files,
    prior,
    args.lens
      ? { lens: args.lens, scope: args.scope }
      : { narrow: true, priorPasses: args.priorPasses },
  );

  if (args.print) {
    process.stdout.write(prompt);
    process.exit(0);
  }

  const label = args.lens ? `${args.lens}, ${args.scope}` : "narrow";
  console.log(
    `Flightplan review (${args.engine}, ${label}) — ${files.length} file(s):`,
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
