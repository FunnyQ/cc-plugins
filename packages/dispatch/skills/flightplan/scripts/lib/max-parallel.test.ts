import { describe, expect, test } from "bun:test";
import { parseMaxParallel, readPlan, serialProseHit } from "./max-parallel";

describe("parseMaxParallel", () => {
  test("an absent header is undeclared and unbounded", () => {
    expect(parseMaxParallel("# Plan\n\n> **Status**: approved\n")).toEqual({
      ok: true,
      declared: false,
      value: null,
    });
  });

  test("a positive integer caps the wave", () => {
    expect(parseMaxParallel("> **Max parallel**: 1\n")).toEqual({
      ok: true,
      declared: true,
      value: 1,
    });
    expect(parseMaxParallel("> **Max parallel**: 3")).toMatchObject({
      value: 3,
    });
  });

  test("unlimited is a declaration with no cap", () => {
    expect(parseMaxParallel("> **Max parallel**: unlimited\n")).toEqual({
      ok: true,
      declared: true,
      value: null,
    });
  });

  test.each(["0", "serial", "1 (lock)", "-1", "1.5", ""])(
    "rejects %p rather than reading it as no cap",
    (raw) => {
      const parsed = parseMaxParallel(`> **Max parallel**: ${raw}\n`);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toContain("Max parallel");
    },
  );
});

describe("serialProseHit", () => {
  test.each([
    "Execution is serial: each task holds the integration lock `/tmp/x.lock`.",
    "Tasks run one task at a time.",
    "Acquire it with mkdir /tmp/sketchybard-live.lock before the first write.",
    "Serial execution is required because the device is shared.",
  ])("flags %p", (line) => {
    expect(serialProseHit(`intro\n${line}\n`)).toBe(line);
  });

  // Measured on the real Swift plan that motivated this rule: its API context
  // talks about serial dispatch queues, which say nothing about task scheduling.
  test.each([
    "- `sketchybard.mach` (serial) — Mach receive only.",
    "One private serial queue per `BarClient`.",
    "Run `bun install` to refresh bun.lock.",
  ])("ignores %p", (line) => {
    expect(serialProseHit(line)).toBeNull();
  });
});

describe("readPlan", () => {
  test("returns null only when the plan does not exist", async () => {
    expect(await readPlan("/nonexistent/q-lab/PLAN.md")).toBeNull();
  });

  test("throws on any other read failure, since an unreadable plan may still declare a cap", async () => {
    await expect(readPlan(import.meta.dir)).rejects.toThrow();
  });
});
