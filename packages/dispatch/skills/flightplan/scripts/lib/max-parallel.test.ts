import { describe, expect, test } from "bun:test";
import { parseMaxParallel, serialProseHit } from "./max-parallel";

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

  // A misspelt cap must not read as "no cap": that is the silent parallel run
  // the header exists to prevent.
  test.each(["0", "serial", "1 (lock)", "-1", "1.5", ""])(
    "rejects %p",
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
