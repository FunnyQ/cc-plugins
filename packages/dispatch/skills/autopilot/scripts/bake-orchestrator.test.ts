import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bakeConfig,
  bakedScriptPath,
  bakeOrchestrator,
} from "./bake-orchestrator";

const SCRIPT = join(import.meta.dir, "bake-orchestrator.ts");
const DOC = await readFile(
  join(import.meta.dir, "..", "references", "orchestrator.md"),
  "utf-8",
);

const scouted = (root: string) => ({
  slug: "my-plan",
  repoRoot: root,
  tasksDir: `${root}/docs/my-plan/tasks`,
  planPath: `${root}/docs/my-plan/PLAN.md`,
  logFile: `${root}/docs/my-plan/.flightlog/run.jsonl`,
  planGoal: 'Ship it — costs $5, says "done"',
  scriptsDir: "/abs/flightplan/scripts",
  baseRef: "abc123",
});

describe("bakeOrchestrator", () => {
  test("bakes each value as a literal and keeps the field comment", () => {
    const script = bakeOrchestrator(DOC, {
      ...scouted("/r"),
      devEngine: "codex",
      maxAttempts: 5,
      resumeModelsRaw: null,
    });
    expect(script).toMatch(/^\s*repoRoot:\s*"\/r",\s*\/\/ ABSOLUTE/m);
    expect(script).toMatch(/^\s*devEngine:\s*"codex",/m);
    expect(script).toMatch(/^\s*maxAttempts:\s*5,/m);
    expect(script).toContain(
      `planGoal:              "Ship it — costs $5, says \\"done\\"",`,
    );
    expect(script.startsWith("export const meta")).toBe(true);
  });

  test("produces a script that parses", () => {
    const script = bakeOrchestrator(DOC, scouted("/r")).replace(
      /^export const meta/m,
      "const meta",
    );
    expect(
      () => new Function(`return (async () => { ${script} })`),
    ).not.toThrow();
  });

  test("derives planDir from planPath so a nested plan reaches worktree.ts", () => {
    const script = bakeOrchestrator(DOC, {
      ...scouted("/r"),
      planPath: "/r/docs/site/legs/02-hub/PLAN.md",
    });
    expect(script).toMatch(/^\s*planDir:\s*"\/r\/docs\/site\/legs\/02-hub",/m);
    expect(script).toContain("--plan-dir ${CFG.planDir}");
  });

  test("refuses a missing required field", () => {
    const { baseRef: _, ...values } = scouted("/r");
    expect(() => bakeOrchestrator(DOC, values)).toThrow(
      "missing required CFG fields: baseRef",
    );
  });

  test("refuses a relative path", () => {
    expect(() =>
      bakeOrchestrator(DOC, {
        ...scouted("/r"),
        logFile: "docs/my-plan/.flightlog/run.jsonl",
      }),
    ).toThrow("CFG.logFile must be an absolute path");
  });

  test("refuses a field the CFG block does not carry", () => {
    expect(() => bakeOrchestrator(DOC, { ...scouted("/r"), typo: 1 })).toThrow(
      "config field not found in orchestrator script: typo",
    );
  });
});

test("bakeConfig touches only the CFG block", () => {
  const script =
    "const CFG = {\n  dev: 'a', // c\n}\nconst MODEL = {\n  dev: { model: 'opus' },\n}";
  expect(bakeConfig(script, { dev: "'b'" })).toBe(
    "const CFG = {\n  dev: 'b', // c\n}\nconst MODEL = {\n  dev: { model: 'opus' },\n}",
  );
});

test("bakedScriptPath lands in the plan's .flightlog", () => {
  expect(bakedScriptPath("/r/docs/my-plan/PLAN.md")).toBe(
    "/r/docs/my-plan/.flightlog/orchestrator.js",
  );
});

test("CLI writes the script beside a self-ignore and prints its path", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-orchestrator-"));
  try {
    const proc = Bun.spawn(["bun", SCRIPT], {
      stdin: new Blob([JSON.stringify(scouted(root))]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const out = join(root, "docs", "my-plan", ".flightlog", "orchestrator.js");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(out);
    expect(await readFile(out, "utf-8")).toContain(
      `repoRoot:              ${JSON.stringify(root)},`,
    );
    expect(
      await readFile(
        join(root, "docs", "my-plan", ".flightlog", ".gitignore"),
        "utf-8",
      ),
    ).toBe("*\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI exits 1 with the reason on bad input", async () => {
  const proc = Bun.spawn(["bun", SCRIPT], {
    stdin: new Blob(["{}"]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(1);
  expect(stderr).toContain("missing required CFG fields");
});
