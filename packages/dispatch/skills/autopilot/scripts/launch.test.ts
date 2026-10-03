import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSource } from "./graph-source";
import { parseArgs, planLine, validatePlanDir } from "./launch";

describe("parseArgs", () => {
  test("parses valid arguments", () => {
    expect(parseArgs(["--plan", "/plan", "--port", "6000"], {})).toEqual({
      ok: true,
      args: { plan: "/plan", port: 6000, open: true },
    });
  });

  test("rejects a missing plan", () => {
    expect(parseArgs([])).toEqual({
      ok: false,
      message: "--plan must be an absolute path",
    });
  });

  test("rejects a relative plan", () => {
    expect(parseArgs(["--plan", "relative/plan"])).toEqual({
      ok: false,
      message: "--plan must be an absolute path",
    });
  });

  test("rejects an out-of-range port", () => {
    expect(parseArgs(["--plan", "/plan", "--port", "65536"]).ok).toBeFalse();
  });

  test("suppresses opening the browser", () => {
    expect(parseArgs(["--plan", "/plan", "--no-open"], {})).toEqual({
      ok: true,
      args: { plan: "/plan", port: 5757, open: false },
    });
  });

  test("uses the default port", () => {
    expect(parseArgs(["--plan", "/plan"], {})).toEqual({
      ok: true,
      args: { plan: "/plan", port: 5757, open: true },
    });
  });

  test("under Claude Code the pane stands in, so the browser stays shut unless --open asks", () => {
    const claude = { CLAUDECODE: "1" };
    expect(parseArgs(["--plan", "/plan"], claude)).toMatchObject({ args: { open: false } });
    expect(parseArgs(["--plan", "/plan", "--open"], claude)).toMatchObject({ args: { open: true } });
    expect(parseArgs(["--plan", "/plan", "--no-open"], {})).toMatchObject({ args: { open: false } });
  });
});

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-source-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("detectSource and validatePlanDir", () => {
  for (const shape of ["tasks", "graph", "both", "none"] as const) {
    test(`detects and validates ${shape}`, () => {
      const dir = scratch();
      if (shape === "tasks" || shape === "both") mkdirSync(join(dir, "tasks"));
      if (shape === "graph" || shape === "both") writeFileSync(join(dir, "graph.json"), "{}");
      expect(detectSource(dir)).toBe(shape === "both" ? "tasks" : shape);
      expect(validatePlanDir(dir)).toEqual(shape === "none"
        ? { ok: false, message: "--plan must contain a tasks/ directory or a graph.json file" }
        : { ok: true });
    });
  }

  test("requires a task directory or a graph file, not just their names", () => {
    const dir = scratch();
    writeFileSync(join(dir, "tasks"), "");
    mkdirSync(join(dir, "graph.json"));
    expect(detectSource(dir)).toBe("none");
    expect(validatePlanDir(dir)).toEqual({ ok: false, message: "--plan must contain a tasks/ directory or a graph.json file" });
  });

  test("keeps the missing path and non-directory errors", () => {
    const dir = scratch();
    const file = join(dir, "file");
    writeFileSync(file, "");
    expect(validatePlanDir(file)).toEqual({ ok: false, message: "--plan must be a directory" });
    expect(validatePlanDir(join(dir, "absent"))).toEqual({ ok: false, message: "--plan directory does not exist" });
  });
});

describe("planLine", () => {
  test("names the plan the launcher served, for the dispatch mod to read back", () => {
    expect(planLine("/abs/docs/x")).toBe("flightdeck plan: /abs/docs/x");
  });
});
