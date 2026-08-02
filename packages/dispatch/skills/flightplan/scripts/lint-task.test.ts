import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lintFile,
  collectTaskFiles,
  inferRefFromPath,
  checkFinalReview,
  testCommandsIn,
  checkFinalReviewTestNet,
  extractTestPaths,
  formatTestNetReport,
  testNetReport,
} from "./lint-task";
import { parseTask, type ParsedTask } from "./lib/parse-task";

// Minimal ParsedTask for graph checks — bucket/nn/dependsOn/finalReview read.
const mk = (
  bucket: string,
  nn: string,
  deps: Array<[string, string]> = [],
  finalReview = false,
): ParsedTask =>
  ({
    bucket,
    nn,
    dependsOn: deps.map(([b, n]) => ({ bucket: b, nn: n })),
    finalReview,
  }) as unknown as ParsedTask;

const VALID_TASK = `# UI-01: Fixture state shell

> **Required reading**:
> - \`../_context/shared.md\`
>
> **Depends on**: none
> **Status**: todo

## Goal
One sentence.

## Files to create / modify
- a.ts (new)

## Acceptance criteria
- [ ] One

## Verification
- [ ] Run \`bun test\`

## Eval rubric

> Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 4–5 (pass) |
|---|---|---|
| Correctness | ×3 | correct |
| Test coverage | ×1 | covers edges |
`;

async function writeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flightplan-lint-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  return root;
}

const taskWith = ({
  bucket,
  nn,
  dependsOn = "none",
  finalReview = false,
  verification = "bun test",
}: {
  bucket: string;
  nn: string;
  dependsOn?: string;
  finalReview?: boolean;
  verification?: string | null;
}) =>
  VALID_TASK.replace("# UI-01", `# ${bucket.toUpperCase()}-${nn}`)
    .replace("**Depends on**: none", `**Depends on**: ${dependsOn}`)
    .replace(
      "> **Status**: todo",
      `${finalReview ? "> **Final review**: true\n" : ""}> **Status**: todo`,
    )
    .replace(
      "- [ ] Run `bun test`",
      verification === null
        ? "- [ ] Check output"
        : `- [ ] Run \`${verification}\``,
    );

async function runCli(input: string) {
  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "lint-task.ts"), input],
    {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("lintFile", () => {
  test("valid task → no violations", async () => {
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": VALID_TASK,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations).toEqual([]);
    await rm(root, { recursive: true });
  });

  test("missing Required reading paths → violation", async () => {
    const root = await writeTree({
      "tasks/ui/01-foo.md": VALID_TASK, // shared.md not created
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "required-reading")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("Required reading outside _context/ → violation", async () => {
    const bad = VALID_TASK.replace(
      "`../_context/shared.md`",
      "`../../docs/PLAN.md`",
    );
    const root = await writeTree({ "tasks/ui/01-foo.md": bad });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "required-reading")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("Required reading must be sibling ../_context — absolute path rejected", async () => {
    const bad = VALID_TASK.replace(
      "`../_context/shared.md`",
      "`/Users/foo/tasks/_context/shared.md`",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some(
        (v) =>
          v.rule === "required-reading" && /sibling _context/.test(v.detail),
      ),
    ).toBe(true);
    await rm(root, { recursive: true });
  });

  test("Required reading must be sibling — deep traversal rejected", async () => {
    const bad = VALID_TASK.replace(
      "`../_context/shared.md`",
      "`../../something/_context/shared.md`",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some(
        (v) =>
          v.rule === "required-reading" && /sibling _context/.test(v.detail),
      ),
    ).toBe(true);
    await rm(root, { recursive: true });
  });

  test("body mentions PLAN.md → violation", async () => {
    const bad = VALID_TASK.replace("One sentence.", "See PLAN.md for context.");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "self-containment")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("body mentions plan.md (lowercase) → violation", async () => {
    const bad = VALID_TASK.replace("One sentence.", "See plan.md for context.");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "self-containment")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("body references sibling task file (with .md) → violation", async () => {
    const bad = VALID_TASK.replace(
      "One sentence.",
      "Follow the pattern from ui/02-bar.md.",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "self-containment")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("body references sibling shorthand bucket/NN → violation", async () => {
    const bad = VALID_TASK.replace(
      "One sentence.",
      "After ui/02 is done, this can ship.",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "self-containment")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("body referencing its OWN file path → no violation", async () => {
    const ok = VALID_TASK.replace(
      "One sentence.",
      "This task lives at ui/01-foo.md.",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": ok,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.filter((v) => v.rule === "self-containment")).toEqual([]);
    await rm(root, { recursive: true });
  });

  test("body with a deeper file path (not a sibling ref) → no violation", async () => {
    // `assets/icons/03-logo.svg` has a bucket-like middle segment but is a real
    // asset path, not a sibling task — the lookbehind must keep it off the radar.
    const ok = VALID_TASK.replace(
      "One sentence.",
      "Render the sprite from `assets/icons/03-logo.svg`.",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": ok,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.filter((v) => v.rule === "self-containment")).toEqual([]);
    await rm(root, { recursive: true });
  });

  test("H1 bucket/NN mismatches file path → violation", async () => {
    // File path says ui/01 but H1 claims API-99
    const bad = VALID_TASK.replace(
      "# UI-01: Fixture state shell",
      "# API-99: Bogus claim",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "h1-path-mismatch")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("missing Acceptance criteria section → violation", async () => {
    const bad = VALID_TASK.replace(
      /## Acceptance criteria\n- \[ \] One\n\n/,
      "",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "sections")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("Acceptance criteria with no checkbox → violation", async () => {
    const bad = VALID_TASK.replace("- [ ] One", "Just prose, no checkbox.");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some(
        (v) => v.rule === "sections" && /checkbox/.test(v.detail),
      ),
    ).toBe(true);
    await rm(root, { recursive: true });
  });

  test("missing Verification section → violation", async () => {
    const bad = VALID_TASK.replace(/## Verification[\s\S]*$/, "");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some(
        (v) => v.rule === "sections" && /Verification/.test(v.detail),
      ),
    ).toBe(true);
    await rm(root, { recursive: true });
  });

  test("bad status value → violation", async () => {
    const bad = VALID_TASK.replace("**Status**: todo", "**Status**: pending");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "status")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("status with trailing junk → violation", async () => {
    const bad = VALID_TASK.replace(
      "**Status**: todo",
      "**Status**: todo maybe",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "status")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("done with an unticked gate box → completion-state violation", async () => {
    const bad = VALID_TASK.replace("**Status**: todo", "**Status**: done");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    const hit = violations.find((v) => v.rule === "completion-state");
    expect(hit).toBeDefined();
    expect(hit!.detail).toMatch(/Do NOT tick the boxes by hand/);
    expect(hit!.detail).toMatch(/`in-progress` or `todo`/);
    await rm(root, { recursive: true });
  });

  test("done with every gate box ticked → no completion-state violation", async () => {
    const good = VALID_TASK.replace(
      "**Status**: todo",
      "**Status**: done",
    ).replaceAll("- [ ]", "- [x]");
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": good,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations).toEqual([]);
    await rm(root, { recursive: true });
  });

  test("malformed file → parse violation", async () => {
    const root = await writeTree({
      "tasks/ui/01-foo.md": "no h1, no quote, just text",
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "parse")).toBe(true);
    await rm(root, { recursive: true });
  });

  test("valid task carries no rubric violation", async () => {
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": VALID_TASK,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(violations.some((v) => v.rule === "rubric")).toBe(false);
    await rm(root, { recursive: true });
  });

  test("missing Eval rubric section → violation", async () => {
    const bad = VALID_TASK.slice(0, VALID_TASK.indexOf("## Eval rubric"));
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some((v) => v.rule === "rubric" && /missing/.test(v.detail)),
    ).toBe(true);
    await rm(root, { recursive: true });
  });

  test("Eval rubric present but unparseable → violation", async () => {
    const bad = VALID_TASK.replace(
      "> Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.",
      "> Just eyeball it, close enough is fine.",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some(
        (v) => v.rule === "rubric" && /unparseable/.test(v.detail),
      ),
    ).toBe(true);
    await rm(root, { recursive: true });
  });

  test("pass threshold out of scale → violation", async () => {
    const bad = VALID_TASK.replace(
      "weighted average > 4.0 to pass",
      "weighted average > 9 to pass",
    );
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-foo.md": bad,
    });
    const violations = await lintFile(join(root, "tasks/ui/01-foo.md"));
    expect(
      violations.some((v) => v.rule === "rubric" && /scale/.test(v.detail)),
    ).toBe(true);
    await rm(root, { recursive: true });
  });
});

describe("testCommandsIn", () => {
  test("finds bun test command in Verification", () => {
    const task = VALID_TASK.replace(
      "- [ ] Run `bun test`",
      "- [ ] Run `bun test packages/foo`",
    );
    const parsed = parseTask(task);
    expect(parsed.ok && testCommandsIn(parsed.task)).toEqual([
      "bun test packages/foo",
    ]);
  });

  test("finds npm test variants", () => {
    const task = VALID_TASK.replace(
      "- [ ] Run `bun test`",
      `- [ ] Run \`npm test\` or \`npm run test\` or \`pnpm test\` or \`pnpm run test\` or \`yarn test\` or \`yarn run test\``,
    );
    const parsed = parseTask(task);
    expect(parsed.ok && testCommandsIn(parsed.task)).toEqual([
      "npm test",
      "npm run test",
      "pnpm test",
      "pnpm run test",
      "yarn test",
      "yarn run test",
    ]);
  });

  test("finds cargo test, pytest, go test, rspec, make test", () => {
    const task = VALID_TASK.replace(
      "- [ ] Run `bun test`",
      `- [ ] Run \`cargo test\`, \`pytest\`, \`go test ./...\`, \`rspec\`, or \`make test\``,
    );
    const parsed = parseTask(task);
    expect(parsed.ok && testCommandsIn(parsed.task)).toEqual([
      "cargo test",
      "pytest",
      "go test ./...",
      "rspec",
      "make test",
    ]);
  });

  test("rejects near-misses: bun testify, make tested, rspecs, npm testx", () => {
    const task = VALID_TASK.replace(
      "- [ ] Run `bun test`",
      `- [ ] Do NOT run \`bun testify\`, \`make tested\`, \`rspecs\`, or \`npm testx\``,
    );
    const parsed = parseTask(task);
    expect(parsed.ok && testCommandsIn(parsed.task)).toEqual([]);
  });

  test("returns [] when no Verification section", () => {
    const task = VALID_TASK.replace(
      "## Verification\n- [ ] Run `bun test`\n",
      "",
    );
    const parsed = parseTask(task);
    expect(parsed.ok && testCommandsIn(parsed.task)).toEqual([]);
  });

  test("ignores test commands in prose (not checklist items)", () => {
    const task = VALID_TASK.replace(
      "- [ ] Run `bun test`",
      `- [ ] Check the output
Note: do not run \`bun test\` in production.`,
    );
    const parsed = parseTask(task);
    expect(parsed.ok && testCommandsIn(parsed.task)).toEqual([]);
  });

  test("recognizes both - [ ] and - [x] forms", () => {
    const task = VALID_TASK.replace(
      "- [ ] Run `bun test`",
      `- [x] Run \`bun test\`
- [ ] Run \`npm test\``,
    );
    const parsed = parseTask(task);
    expect(parsed.ok && testCommandsIn(parsed.task)).toEqual([
      "bun test",
      "npm test",
    ]);
  });

  test("finds test command on continuation line", () => {
    const task = VALID_TASK.replace(
      "- [ ] Run `bun test`",
      `- [ ] Run the build,
      then \`bun test some/dir\` exits 0,
      and \`git status\` shows nothing.`,
    );
    const parsed = parseTask(task);
    expect(parsed.ok && testCommandsIn(parsed.task)).toEqual([
      "bun test some/dir",
    ]);
  });

  test("blank line closes an item, so prose after it is not attributed", () => {
    const task = VALID_TASK.replace(
      "- [ ] Run `bun test`",
      `- [ ] Check the output

Note: run \`bun test\` separately to verify.`,
    );
    const parsed = parseTask(task);
    expect(parsed.ok && testCommandsIn(parsed.task)).toEqual([]);
  });
});

describe("extractTestPaths", () => {
  test.each([
    ["bun test src/a.test.ts", ["src/a.test.ts"]],
    ["cargo test crates/core", ["crates/core"]],
    ["go test ./...", ["./..."]],
    ["make test spec/unit", ["spec/unit"]],
    ["npm test test/unit", ["test/unit"]],
    ["pnpm test test/unit", ["test/unit"]],
    ["yarn test test/unit", ["test/unit"]],
    ["npm run test test/unit", ["test/unit"]],
    ["pnpm run test test/unit", ["test/unit"]],
    ["yarn run test test/unit", ["test/unit"]],
    ["pytest tests/unit", ["tests/unit"]],
    ["rspec spec/models", ["spec/models"]],
  ])("fully consumes the runner prefix in %s", (command, expected) => {
    const paths = extractTestPaths(command);
    expect(paths).toEqual(expected);
    expect(paths).not.toContain("test");
    expect(paths).not.toContain("run");
  });

  test("drops flags and preserves path-ish arguments verbatim", () => {
    expect(
      extractTestPaths("bun test --watch ./Some-Path/{a,b}.test.ts -u"),
    ).toEqual(["./Some-Path/{a,b}.test.ts"]);
  });

  test("returns no paths for an argument-less runner", () => {
    expect(extractTestPaths("bun test")).toEqual([]);
  });
});

describe("testNetReport", () => {
  const withCommand = (
    bucket: string,
    nn: string,
    command: string | null,
    finalReview = false,
  ) =>
    ({
      ...mk(bucket, nn, [], finalReview),
      body:
        command === null
          ? "## Verification\n- [ ] Check output"
          : `## Verification\n- [ ] Run \`${command}\``,
    }) as unknown as ParsedTask;

  test("omits tasks without tests and sorts final review last", () => {
    expect(
      testNetReport([
        withCommand("review", "01", "bun test", true),
        withCommand("docs", "01", null),
        withCommand("ui", "01", "npm run test ui/", false),
      ]),
    ).toEqual([
      {
        ref: "ui/01",
        finalReview: false,
        commands: ["npm run test ui/"],
        paths: ["ui/"],
      },
      {
        ref: "review/01",
        finalReview: true,
        commands: ["bun test"],
        paths: [],
      },
    ]);
  });

  test("returns [] when no task runs tests", () => {
    expect(testNetReport([withCommand("docs", "01", null)])).toEqual([]);
  });

  test("formatter labels final review and renders empty paths as all", () => {
    const output = formatTestNetReport([
      {
        ref: "ui/01",
        finalReview: false,
        commands: ["bun test ui/"],
        paths: ["ui/"],
      },
      {
        ref: "review/01",
        finalReview: true,
        commands: ["bun test"],
        paths: [],
      },
    ]);
    expect(output).toContain("Test net report:");
    expect(output).toContain("ui/01");
    expect(output).toContain("review/01 [final review]");
    expect(output).toContain("paths: (all)");
  });
});

describe("CLI test-net report", () => {
  test("clean tree prints report to stdout and exits 0", async () => {
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-work.md": taskWith({ bucket: "ui", nn: "01" }),
      "tasks/review/01-close.md": taskWith({
        bucket: "review",
        nn: "01",
        dependsOn: "ui/01",
        finalReview: true,
      }),
    });
    const result = await runCli(join(root, "tasks"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Test net report:");
    expect(result.stderr).toBe("");
    await rm(root, { recursive: true });
  });

  test("violating tree reports stderr but still prints stdout report", async () => {
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-work.md": taskWith({ bucket: "ui", nn: "01" }),
      "tasks/review/01-close.md": taskWith({
        bucket: "review",
        nn: "01",
        finalReview: true,
      }),
    });
    const result = await runCli(join(root, "tasks"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[final-review]");
    expect(result.stdout).toContain("Test net report:");
    await rm(root, { recursive: true });
  });

  test("single task file prints no report", async () => {
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-work.md": taskWith({ bucket: "ui", nn: "01" }),
    });
    const result = await runCli(join(root, "tasks/ui/01-work.md"));
    expect(result.stdout).not.toContain("Test net report:");
    await rm(root, { recursive: true });
  });

  test("tree with no tests prints no report", async () => {
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/ui/01-work.md": taskWith({
        bucket: "ui",
        nn: "01",
        verification: null,
      }),
      "tasks/review/01-close.md": taskWith({
        bucket: "review",
        nn: "01",
        dependsOn: "ui/01",
        finalReview: true,
        verification: null,
      }),
    });
    const result = await runCli(join(root, "tasks"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Test net report:");
    await rm(root, { recursive: true });
  });
});

describe("checkFinalReview", () => {
  test("single task is exempt", () => {
    expect(checkFinalReview([mk("work", "01")], "t")).toEqual([]);
  });

  test("marked task depending on all others → ok", () => {
    const tasks = [
      mk("ui", "01"),
      mk("backend", "01"),
      mk(
        "review",
        "01",
        [
          ["ui", "01"],
          ["backend", "01"],
        ],
        true,
      ),
    ];
    expect(checkFinalReview(tasks, "t")).toEqual([]);
  });

  test("marked task reaching all leaves transitively → ok", () => {
    const tasks = [
      mk("ui", "01"),
      mk("ui", "02", [["ui", "01"]]),
      mk("backend", "01"),
      mk("backend", "02", [["backend", "01"]]),
      mk(
        "review",
        "01",
        [
          ["ui", "02"],
          ["backend", "02"],
        ],
        true,
      ),
    ];
    expect(checkFinalReview(tasks, "t")).toEqual([]);
  });

  test("no marked task → violation (even if a task covers all)", () => {
    const tasks = [
      mk("ui", "01"),
      mk("backend", "01"),
      mk("review", "01", [
        ["ui", "01"],
        ["backend", "01"],
      ]), // covers all but NOT marked
    ];
    const v = checkFinalReview(tasks, "t");
    expect(v.length).toBe(1);
    expect(v[0].rule).toBe("final-review");
    expect(v[0].detail).toMatch(/Final review/);
  });

  test("marked but missing a branch → violation lists what it misses", () => {
    const tasks = [
      mk("ui", "01"),
      mk("ingestion", "01"),
      mk("review", "01", [["ui", "01"]], true), // misses ingestion/01
    ];
    const v = checkFinalReview(tasks, "t");
    expect(v.length).toBe(1);
    expect(v[0].detail).toMatch(/ingestion\/01/);
  });
});

describe("checkFinalReviewTestNet", () => {
  test("fires when tree has tests but final review does not", () => {
    const tasks: ParsedTask[] = [
      {
        ...mk("lint", "01", [], false),
        body: "## Verification\n- [ ] `bun test`",
      } as unknown as ParsedTask,
      {
        ...mk("review", "01", [], true),
        body: "## Verification\n- [ ] Check results",
      } as unknown as ParsedTask,
    ];
    const violations = checkFinalReviewTestNet(tasks, "tasks");
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe("final-review-test-net");
    expect(violations[0].detail).toContain("lint/01");
    expect(violations[0].detail).toContain("bun test");
    expect(violations[0].detail).toContain("review/01");
  });

  test("silent when tree has no test commands", () => {
    const tasks: ParsedTask[] = [
      {
        ...mk("docs", "01", [], false),
        body: "## Verification\n- [ ] Check prose",
      } as unknown as ParsedTask,
      {
        ...mk("review", "01", [], true),
        body: "## Verification\n- [ ] Check results",
      } as unknown as ParsedTask,
    ];
    expect(checkFinalReviewTestNet(tasks, "tasks")).toEqual([]);
  });

  test("silent when final review task has a test command", () => {
    const tasks: ParsedTask[] = [
      {
        ...mk("lint", "01", [], false),
        body: "## Verification\n- [ ] `bun test`",
      } as unknown as ParsedTask,
      {
        ...mk("review", "01", [], true),
        body: "## Verification\n- [ ] `pytest`",
      } as unknown as ParsedTask,
    ];
    expect(checkFinalReviewTestNet(tasks, "tasks")).toEqual([]);
  });

  test("silent when tree is single-task", () => {
    const tasks: ParsedTask[] = [
      {
        ...mk("review", "01", [], true),
        body: "## Verification\n- [ ] Check it",
      } as unknown as ParsedTask,
    ];
    expect(checkFinalReviewTestNet(tasks, "tasks")).toEqual([]);
  });

  test("silent when no final-review marker", () => {
    const tasks: ParsedTask[] = [
      {
        ...mk("lint", "01", [], false),
        body: "## Verification\n- [ ] `bun test`",
      } as unknown as ParsedTask,
      {
        ...mk("review", "01", [], false),
        body: "## Verification\n- [ ] Check results",
      } as unknown as ParsedTask,
    ];
    expect(checkFinalReviewTestNet(tasks, "tasks")).toEqual([]);
  });

  test("violation includes refs of all tasks with tests", () => {
    const tasks: ParsedTask[] = [
      {
        ...mk("feat", "01", [], false),
        body: "## Verification\n- [ ] `bun test`",
      } as unknown as ParsedTask,
      {
        ...mk("feat", "02", [], false),
        body: "## Verification\n- [ ] `npm test`",
      } as unknown as ParsedTask,
      {
        ...mk("review", "01", [], true),
        body: "## Verification\n- [ ] No tests",
      } as unknown as ParsedTask,
    ];
    const violations = checkFinalReviewTestNet(tasks, "tasks");
    expect(violations.length).toBe(1);
    expect(violations[0].detail).toContain("feat/01");
    expect(violations[0].detail).toContain("feat/02");
    expect(violations[0].detail).toContain("bun test");
    expect(violations[0].detail).toContain("npm test");
  });

  // Two markers: the stray one runs a test, the covering one does not. Judging
  // the first marker in document order would call this tree clean and let the
  // real closing gate ship with no test at all.
  test("judges the covering marker, not the first one, when a tree has two", () => {
    const tasks: ParsedTask[] = [
      {
        ...mk("feat", "01", [], false),
        body: "## Verification\n- [ ] `bun test`",
      } as unknown as ParsedTask,
      {
        ...mk("stray", "01", [], true), // marked, covers nothing
        body: "## Verification\n- [ ] `bun test`",
      } as unknown as ParsedTask,
      {
        ...mk(
          "review",
          "01",
          [
            ["feat", "01"],
            ["stray", "01"],
          ],
          true,
        ), // marked AND covering
        body: "## Verification\n- [ ] Check results",
      } as unknown as ParsedTask,
    ];
    const violations = checkFinalReviewTestNet(tasks, "tasks");
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe("final-review-test-net");
    expect(violations[0].detail).toContain("(review/01) runs no tests");
  });
});

describe("collectTaskFiles", () => {
  test("skips _context/ and README.md", async () => {
    const root = await writeTree({
      "tasks/_context/shared.md": "# Shared\n",
      "tasks/README.md": "# Index\n",
      "tasks/ui/01-foo.md": VALID_TASK,
      "tasks/ui/02-bar.md": VALID_TASK,
      "tasks/backend/01-baz.md": VALID_TASK,
    });
    const files = await collectTaskFiles(join(root, "tasks"));
    expect(files).toHaveLength(3);
    expect(files.every((f) => !f.includes("_context"))).toBe(true);
    expect(files.every((f) => !f.endsWith("README.md"))).toBe(true);
    await rm(root, { recursive: true });
  });

  test("ignores non-md files inside bucket dirs", async () => {
    const root = await writeTree({
      "tasks/ui/01-foo.md": VALID_TASK,
      "tasks/ui/.gitkeep": "",
      "tasks/ui/notes.txt": "scratch",
    });
    const files = await collectTaskFiles(join(root, "tasks"));
    expect(files).toHaveLength(1);
    await rm(root, { recursive: true });
  });
});

describe("inferRefFromPath", () => {
  test("extracts bucket and NN from canonical path", () => {
    expect(inferRefFromPath("/abs/docs/x/tasks/ui/01-foo.md")).toEqual({
      bucket: "ui",
      nn: "01",
    });
  });

  test("returns null when filename lacks NN- prefix", () => {
    expect(inferRefFromPath("/abs/tasks/ui/foo.md")).toBeNull();
  });

  test("returns null when bucket name has dashes", () => {
    expect(inferRefFromPath("/abs/tasks/my-bucket/01-foo.md")).toBeNull();
  });
});

describe("scope-git-status rule", () => {
  const withVerification = (items: string) =>
    VALID_TASK.replace("- [ ] Run `bun test`", items);

  const lintOne = async (body: string) => {
    const root = await writeTree({
      "tasks/ui/01-fixture-state-shell.md": body,
    });
    const violations = await lintFile(
      join(root, "tasks/ui/01-fixture-state-shell.md"),
    );
    await rm(root, { recursive: true, force: true });
    return violations;
  };

  test("flags a git status check that expects one path", async () => {
    const violations = await lintOne(
      withVerification(
        "- [ ] Run `git status --short` — expect `README.md` as the only modified path.",
      ),
    );

    const scope = violations.find((v) => v.rule === "scope-git-status");
    expect(scope).toBeDefined();
    expect(scope!.detail).toContain("pathspec");
  });

  test("flags the same trap phrased as nothing else", async () => {
    const violations = await lintOne(
      withVerification(
        "- [ ] Run `git status --short` and confirm nothing else is modified.",
      ),
    );

    expect(violations.some((v) => v.rule === "scope-git-status")).toBe(true);
  });

  // The shape task-template.md used to recommend. It survives an exclusivity
  // regex by wording alone, yet it still reads the whole tree — a parallel
  // sibling's uncommitted edits fail a correct implementation.
  test("flags a whole-tree check that only judges the other paths", async () => {
    const violations = await lintOne(
      withVerification(
        "- [ ] Run `git status --short` and quote it. Expect `README.md`, plus at most this task file. Any OTHER path is a real scope violation.",
      ),
    );

    const scope = violations.find((v) => v.rule === "scope-git-status");
    expect(scope).toBeDefined();
    expect(scope!.detail).toContain("pathspec");
  });

  test("allows a git status check narrowed by a pathspec", async () => {
    const violations = await lintOne(
      withVerification(
        "- [ ] Run `git status --short -- README.md src/app.ts` and confirm both paths are dirty.",
      ),
    );

    expect(violations.some((v) => v.rule === "scope-git-status")).toBe(false);
  });

  test("still flags an exclusivity claim wrapped around a pathspec check", async () => {
    const violations = await lintOne(
      withVerification(
        "- [ ] Run `git status --short -- README.md`; it must be the only modified path.",
      ),
    );

    const scope = violations.find((v) => v.rule === "scope-git-status");
    expect(scope).toBeDefined();
    expect(scope!.detail).toContain("exclusivity");
  });

  test("allows a path operand written without the -- separator", async () => {
    const violations = await lintOne(
      withVerification(
        "- [ ] Run `git status --short bin/workbench` and confirm it is modified.",
      ),
    );

    expect(violations.some((v) => v.rule === "scope-git-status")).toBe(false);
  });

  test("reads no pathspec out of bare prose", async () => {
    const violations = await lintOne(
      withVerification(
        "- [ ] Run git status --short and quote every entry it prints.",
      ),
    );

    expect(violations.some((v) => v.rule === "scope-git-status")).toBe(true);
  });

  test("flags an item that narrows one invocation but not the other", async () => {
    const violations = await lintOne(
      withVerification(
        "- [ ] Run `git status --short -- src/app.ts`, then `git status --short` for the whole tree.",
      ),
    );

    expect(violations.some((v) => v.rule === "scope-git-status")).toBe(true);
  });

  test("does not accept an option flag as a pathspec", async () => {
    const violations = await lintOne(
      withVerification(
        "- [ ] Run `git status --short --branch` and review every entry it prints.",
      ),
    );

    expect(violations.some((v) => v.rule === "scope-git-status")).toBe(true);
  });

  test("ignores an exclusivity claim that has no git status command", async () => {
    const violations = await lintOne(
      withVerification("- [ ] Confirm `bun test` is the only suite that runs."),
    );

    expect(violations.some((v) => v.rule === "scope-git-status")).toBe(false);
  });

  test("reads the acceptance criteria section too", async () => {
    const violations = await lintOne(
      VALID_TASK.replace(
        "- [ ] One",
        "- [ ] `git status --short` shows only `README.md`.",
      ),
    );

    expect(violations.some((v) => v.rule === "scope-git-status")).toBe(true);
  });
});
