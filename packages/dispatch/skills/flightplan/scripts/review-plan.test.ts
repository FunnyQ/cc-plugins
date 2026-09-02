import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { join as joinPath } from "node:path";
import {
  buildReviewPrompt,
  collapseDuplicateReviewOutput,
  collectPlanFiles,
  formatCodexReviewOutput,
  narrowInstructions,
  parseArgs,
} from "./review-plan";

const SCRIPT = joinPath(import.meta.dir, "review-plan.ts");

async function newRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "flightplan-review-"));
}

describe("collectPlanFiles", () => {
  test("finds PLAN.md", async () => {
    const root = await newRoot();
    await writeFile(join(root, "PLAN.md"), "# Plan\n");

    const result = await collectPlanFiles(root);
    expect(result).toEqual([join(root, "PLAN.md")]);

    await rm(root, { recursive: true });
  });

  test("_context files are collected in order", async () => {
    const root = await newRoot();
    await mkdir(join(root, "tasks/_context"), { recursive: true });
    await writeFile(join(root, "tasks/_context/zeta.md"), "# Zeta\n");
    await writeFile(join(root, "tasks/_context/alpha.md"), "# Alpha\n");

    const result = await collectPlanFiles(root);
    expect(result).toEqual([
      join(root, "tasks/_context/alpha.md"),
      join(root, "tasks/_context/zeta.md"),
    ]);

    await rm(root, { recursive: true });
  });

  test("task files across buckets are collected and README.md is excluded", async () => {
    const root = await newRoot();
    await mkdir(join(root, "tasks/backend"), { recursive: true });
    await mkdir(join(root, "tasks/ui"), { recursive: true });
    await writeFile(join(root, "tasks/ui/02-polish.md"), "# Polish\n");
    await writeFile(join(root, "tasks/ui/README.md"), "# Read me\n");
    await writeFile(join(root, "tasks/backend/01-api.md"), "# API\n");
    await writeFile(join(root, "tasks/backend/README.md"), "# Read me\n");

    const result = await collectPlanFiles(root);
    expect(result).toEqual([
      join(root, "tasks/backend/01-api.md"),
      join(root, "tasks/ui/02-polish.md"),
    ]);

    await rm(root, { recursive: true });
  });

  test("tasks/README.md is collected right after PLAN.md", async () => {
    const root = await newRoot();
    await mkdir(join(root, "tasks/ui"), { recursive: true });
    await writeFile(join(root, "PLAN.md"), "# Plan\n");
    await writeFile(join(root, "tasks/README.md"), "## Known gaps\n- none\n");
    await writeFile(join(root, "tasks/ui/01-build.md"), "# Build\n");

    const result = await collectPlanFiles(root);
    expect(result).toEqual([
      join(root, "PLAN.md"),
      join(root, "tasks/README.md"),
      join(root, "tasks/ui/01-build.md"),
    ]);

    await rm(root, { recursive: true });
  });

  test("a missing tasks/README.md is skipped, bucket READMEs stay excluded", async () => {
    const root = await newRoot();
    await mkdir(join(root, "tasks/ui"), { recursive: true });
    await writeFile(join(root, "tasks/ui/README.md"), "# bucket readme\n");
    await writeFile(join(root, "tasks/ui/01-build.md"), "# Build\n");

    const result = await collectPlanFiles(root);
    expect(result).toEqual([join(root, "tasks/ui/01-build.md")]);

    await rm(root, { recursive: true });
  });

  test("missing dirs are gracefully skipped", async () => {
    const root = await newRoot();
    await writeFile(join(root, "PLAN.md"), "# Plan\n");

    const result = await collectPlanFiles(root);
    expect(result).toEqual([join(root, "PLAN.md")]);

    await rm(root, { recursive: true });
  });

  test("returns empty array when planDir is empty", async () => {
    const root = await newRoot();

    const result = await collectPlanFiles(root);
    expect(result).toEqual([]);

    await rm(root, { recursive: true });
  });
});

describe("buildReviewPrompt", () => {
  test("output starts with review instructions", async () => {
    const root = await newRoot();
    const file = join(root, "PLAN.md");
    await writeFile(file, "# Plan\n");

    const result = await buildReviewPrompt([file]);
    expect(result.startsWith("You are reviewing a flightplan artifact")).toBe(
      true,
    );

    await rm(root, { recursive: true });
  });

  test("each file appears as a header with relative path", async () => {
    const root = await newRoot();
    const plan = join(root, "PLAN.md");
    const task = join(root, "tasks/ui/01-build.md");
    await mkdir(join(root, "tasks/ui"), { recursive: true });
    await writeFile(plan, "# Plan\n");
    await writeFile(task, "# Build\n");

    const result = await buildReviewPrompt([plan, task]);
    expect(result).toContain(`## ${relative(process.cwd(), plan)}`);
    expect(result).toContain(`## ${relative(process.cwd(), task)}`);

    await rm(root, { recursive: true });
  });

  test("file contents are embedded in markdown code fences", async () => {
    const root = await newRoot();
    const file = join(root, "PLAN.md");
    await writeFile(file, "# Plan\n\nAcceptance criteria\n");

    const result = await buildReviewPrompt([file]);
    expect(result).toContain(
      `## ${relative(process.cwd(), file)}\n\`\`\`markdown\n# Plan\n\nAcceptance criteria\n\n\`\`\``,
    );

    await rm(root, { recursive: true });
  });

  test("no prior-findings section when none is passed", async () => {
    const root = await newRoot();
    const file = join(root, "PLAN.md");
    await writeFile(file, "# Plan\n");

    const result = await buildReviewPrompt([file]);
    expect(result).not.toContain("Findings already reported");

    await rm(root, { recursive: true });
  });

  test("prior findings land between the instructions and the plan files", async () => {
    const root = await newRoot();
    const file = join(root, "PLAN.md");
    await writeFile(file, "# Plan\n");

    const result = await buildReviewPrompt(
      [file],
      "P1 ui/01: acceptance criterion is unverifiable",
    );
    expect(result.startsWith("You are reviewing a flightplan artifact")).toBe(
      true,
    );
    const priorIndex = result.indexOf("Findings already reported");
    const verbatimIndex = result.indexOf(
      "P1 ui/01: acceptance criterion is unverifiable",
    );
    const filesIndex = result.indexOf("# Plan Files");
    expect(priorIndex).toBeGreaterThan(-1);
    expect(verbatimIndex).toBeGreaterThan(priorIndex);
    expect(filesIndex).toBeGreaterThan(verbatimIndex);

    await rm(root, { recursive: true });
  });

  test("blank prior findings are treated as absent", async () => {
    const root = await newRoot();
    const file = join(root, "PLAN.md");
    await writeFile(file, "# Plan\n");

    const result = await buildReviewPrompt([file], "   \n  ");
    expect(result).not.toContain("Findings already reported");

    await rm(root, { recursive: true });
  });

  test("files appear in input order", async () => {
    const root = await newRoot();
    const second = join(root, "second.md");
    const first = join(root, "first.md");
    await writeFile(second, "# Second\n");
    await writeFile(first, "# First\n");

    const result = await buildReviewPrompt([second, first]);
    const secondIndex = result.indexOf(`## ${relative(process.cwd(), second)}`);
    const firstIndex = result.indexOf(`## ${relative(process.cwd(), first)}`);
    expect(secondIndex).toBeGreaterThan(-1);
    expect(firstIndex).toBeGreaterThan(secondIndex);

    await rm(root, { recursive: true });
  });
});

describe("collapseDuplicateReviewOutput", () => {
  test("removes an adjacent duplicated full review block", () => {
    const review = [
      "The plan needs two fixes.",
      "",
      "Full review comments:",
      "",
      "- [P2] Fix one - file.md:1",
      "  Details.",
      "",
    ].join("\n");

    const result = collapseDuplicateReviewOutput(`codex\n${review}${review}`);
    expect(result).toBe(`codex\n${review}`);
  });

  test("leaves non-duplicated review output unchanged", () => {
    const output = [
      "The plan needs two fixes.",
      "",
      "Full review comments:",
      "",
      "- [P2] Fix one - file.md:1",
      "  Details.",
      "",
      "Follow-up note.",
      "",
    ].join("\n");

    expect(collapseDuplicateReviewOutput(output)).toBe(output);
  });
});

describe("parseArgs", () => {
  test("defaults: engine codex, no model, not print", () => {
    expect(parseArgs(["docs/my-plan"])).toEqual({
      planDir: "docs/my-plan",
      engine: "codex",
      print: false,
      narrow: false,
    });
  });

  test("--engine opencode + --model are captured", () => {
    expect(
      parseArgs(["docs/my-plan", "--engine", "opencode", "--model", "x/y"]),
    ).toEqual({
      planDir: "docs/my-plan",
      engine: "opencode",
      model: "x/y",
      print: false,
      narrow: false,
    });
  });

  test("--print sets print and ignores engine wiring", () => {
    const out = parseArgs(["docs/my-plan", "--print"]);
    expect(out.print).toBe(true);
    expect(out.planDir).toBe("docs/my-plan");
  });

  test("flag order is irrelevant; planDir can come after flags", () => {
    expect(parseArgs(["--engine", "opencode", "docs/p"]).planDir).toBe(
      "docs/p",
    );
  });

  test("--prior-findings captures the path", () => {
    expect(
      parseArgs(["docs/p", "--prior-findings", "/tmp/round-2.md"])
        .priorFindings,
    ).toBe("/tmp/round-2.md");
  });

  test("rejects --prior-findings with no value", () => {
    expect(() => parseArgs(["docs/p", "--prior-findings"])).toThrow(
      /Missing value after --prior-findings/,
    );
  });

  test("rejects an unknown engine", () => {
    expect(() => parseArgs(["docs/p", "--engine", "gemini"])).toThrow(
      /Unknown --engine/,
    );
  });

  test("rejects an unexpected argument", () => {
    expect(() => parseArgs(["docs/p", "--frob"])).toThrow(
      /Unexpected argument/,
    );
  });

  test("--narrow and --prior-passes are captured", () => {
    const out = parseArgs(["docs/p", "--narrow", "--prior-passes", "8"]);
    expect(out.narrow).toBe(true);
    expect(out.priorPasses).toBe(8);
  });

  test("--narrow alone leaves the pass count unset", () => {
    const out = parseArgs(["docs/p", "--narrow"]);
    expect(out.narrow).toBe(true);
    expect(out.priorPasses).toBeUndefined();
  });

  test("rejects --prior-passes without --narrow", () => {
    expect(() => parseArgs(["docs/p", "--prior-passes", "8"])).toThrow(
      /--prior-passes requires --narrow/,
    );
  });

  test("rejects a non-positive-integer --prior-passes", () => {
    expect(() => parseArgs(["docs/p", "--narrow", "--prior-passes", "0"])).toThrow(
      /positive integer/,
    );
    expect(() =>
      parseArgs(["docs/p", "--narrow", "--prior-passes", "two"]),
    ).toThrow(/positive integer/);
  });
});

describe("narrowInstructions", () => {
  test("states the pass count when given", () => {
    expect(narrowInstructions(8)).toContain(
      "has already been through 8 review passes",
    );
  });

  test("falls back to a countless phrasing", () => {
    expect(narrowInstructions()).toContain(
      "has already been through a full review cycle",
    );
  });

  test("keeps the five-finding cap and the sanctioned clean verdict", () => {
    const text = narrowInstructions(4);
    expect(text).toContain("Report at most five.");
    expect(text).toContain("No blocking findings.");
    // The narrow phase has no P2 channel — the caller counts P1s only.
    expect(text).not.toContain("P2");
  });
});

describe("--print (integration)", () => {
  test("emits the instructions+bundle with no file-list header", async () => {
    const root = await newRoot();
    await writeFile(join(root, "PLAN.md"), "# Plan\n\nGoal: ship it.\n");

    const res = Bun.spawnSync(["bun", SCRIPT, root, "--print"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(res.success).toBe(true);
    const out = res.stdout.toString();
    // The exact review criteria bundle — same source all engines share.
    expect(out.startsWith("You are reviewing a flightplan artifact")).toBe(
      true,
    );
    expect(out).toContain("Goal: ship it.");
    // --print must be clean: no "Flightplan review — N file(s)" header.
    expect(out).not.toContain("Flightplan review");

    await rm(root, { recursive: true });
  });

  // The Opus engine reviews whatever --print emits, so it must reach the narrow
  // phase too; without this the post-cap phase would be codex/opencode-only.
  test("--print honors --narrow", async () => {
    const root = await newRoot();
    await writeFile(join(root, "PLAN.md"), "# Plan\n\nGoal: ship it.\n");

    const res = Bun.spawnSync(
      ["bun", SCRIPT, root, "--print", "--narrow", "--prior-passes", "4"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(res.success).toBe(true);
    const out = res.stdout.toString();
    expect(out).toContain("has already been through 4 review passes");
    expect(out).toContain("Report at most five.");
    expect(out).not.toContain("Focus on:");
    expect(out).toContain("Goal: ship it.");

    await rm(root, { recursive: true });
  });
});

describe("buildReviewPrompt (narrow)", () => {
  test("--narrow swaps the instruction set, keeping the same file bundle", async () => {
    const root = await newRoot();
    const plan = join(root, "PLAN.md");
    await writeFile(plan, "# Plan\n\nGoal: ship it.\n");

    const broad = await buildReviewPrompt([plan]);
    const narrow = await buildReviewPrompt([plan], undefined, { narrow: true });

    expect(broad).toContain("Focus on:");
    expect(narrow).not.toContain("Focus on:");
    expect(narrow).toContain("Report a finding only if it meets this bar");
    // Same tree, either way.
    expect(narrow).toContain("Goal: ship it.");

    await rm(root, { recursive: true });
  });

  test("narrow still folds in prior findings", async () => {
    const root = await newRoot();
    const plan = join(root, "PLAN.md");
    await writeFile(plan, "# Plan\n");

    const out = await buildReviewPrompt([plan], "- [P1] still open", {
      narrow: true,
      priorPasses: 8,
    });
    expect(out).toContain("has already been through 8 review passes");
    expect(out).toContain("# Findings already reported");
    expect(out).toContain("- [P1] still open");

    await rm(root, { recursive: true });
  });
});

describe("formatCodexReviewOutput", () => {
  test("prefers stdout over stderr transcript output", () => {
    const stdout = [
      "The plan needs one fix.",
      "",
      "Full review comments:",
      "",
      "- [P2] Fix one - file.md:1",
      "  Details.",
      "",
    ].join("\n");
    const stderr = [
      "OpenAI Codex v0.139.0",
      "--------",
      "user",
      "transcript",
      stdout,
    ].join("\n");

    expect(formatCodexReviewOutput(stdout, stderr)).toBe(stdout);
  });

  test("falls back to stderr when stdout is empty", () => {
    expect(formatCodexReviewOutput("", "error details\n")).toBe(
      "error details\n",
    );
  });
});
