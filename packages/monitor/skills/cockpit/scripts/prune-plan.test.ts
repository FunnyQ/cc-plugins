// Tests for the pure prune planner.
// Run: bun test packages/monitor/skills/cockpit/scripts/prune-plan.test.ts
import { describe, expect, test } from "bun:test";
import { planPrune, type LogFile } from "./prune-plan";
import type { RegistryEntry } from "./registry";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const CUTOFF = 14 * DAY;

function entry(sessionId: string, ageDays: number): RegistryEntry {
  return {
    provider: "claude",
    project: "/proj",
    sessionId,
    logPath: `/proj/.cockpit/logs/${sessionId}.jsonl`,
    lastHeartbeat: new Date(NOW - ageDays * DAY).toISOString(),
  };
}

function file(sessionId: string, ageDays: number): LogFile {
  return {
    path: `/proj/.cockpit/logs/${sessionId}.jsonl`,
    mtimeMs: NOW - ageDays * DAY,
  };
}

describe("planPrune", () => {
  test("old tracked log → trash file and drop registry entry", () => {
    const plan = planPrune([entry("a", 30)], [file("a", 30)], NOW, CUTOFF);
    expect(plan.trash).toEqual(["/proj/.cockpit/logs/a.jsonl"]);
    expect(plan.dropSessionIds).toEqual(["a"]);
    expect(plan.keptFiles).toBe(0);
    expect(plan.keptEntries).toBe(0);
  });

  test("fresh tracked log → kept", () => {
    const plan = planPrune([entry("a", 2)], [file("a", 2)], NOW, CUTOFF);
    expect(plan.trash).toEqual([]);
    expect(plan.dropSessionIds).toEqual([]);
    expect(plan.keptFiles).toBe(1);
    expect(plan.keptEntries).toBe(1);
  });

  test("orphan old file (no registry entry) → trashed, nothing to drop", () => {
    const plan = planPrune([], [file("orphan", 40)], NOW, CUTOFF);
    expect(plan.trash).toEqual(["/proj/.cockpit/logs/orphan.jsonl"]);
    expect(plan.dropSessionIds).toEqual([]);
  });

  test("orphan fresh file → kept", () => {
    const plan = planPrune([], [file("orphan", 1)], NOW, CUTOFF);
    expect(plan.trash).toEqual([]);
    expect(plan.keptFiles).toBe(1);
  });

  test("fresh file mtime keeps a stale-heartbeat entry alive", () => {
    // heartbeat 30d old, but the log was written 1d ago → still active.
    const plan = planPrune([entry("a", 30)], [file("a", 1)], NOW, CUTOFF);
    expect(plan.trash).toEqual([]);
    expect(plan.dropSessionIds).toEqual([]);
    expect(plan.keptFiles).toBe(1);
  });

  test("dangling entry (file gone) + stale heartbeat → dropped, no trash", () => {
    const plan = planPrune([entry("gone", 30)], [], NOW, CUTOFF);
    expect(plan.trash).toEqual([]);
    expect(plan.dropSessionIds).toEqual(["gone"]);
    expect(plan.keptEntries).toBe(0);
  });

  test("dangling entry (file gone) + fresh heartbeat → kept", () => {
    const plan = planPrune([entry("gone", 1)], [], NOW, CUTOFF);
    expect(plan.trash).toEqual([]);
    expect(plan.dropSessionIds).toEqual([]);
    expect(plan.keptEntries).toBe(1);
  });

  test("mixed set is partitioned correctly", () => {
    const entries = [entry("old", 30), entry("new", 2), entry("dead", 60)];
    const files = [file("old", 30), file("new", 2), file("orphan", 90)];
    const plan = planPrune(entries, files, NOW, CUTOFF);
    expect(plan.trash.sort()).toEqual([
      "/proj/.cockpit/logs/old.jsonl",
      "/proj/.cockpit/logs/orphan.jsonl",
    ]);
    expect(plan.dropSessionIds.sort()).toEqual(["dead", "old"]);
    expect(plan.keptFiles).toBe(1); // new
    expect(plan.keptEntries).toBe(1); // new
  });

  test("cutoff 0 prunes everything", () => {
    const plan = planPrune([entry("a", 0)], [file("a", 0)], NOW, 0);
    expect(plan.trash).toEqual(["/proj/.cockpit/logs/a.jsonl"]);
    expect(plan.dropSessionIds).toEqual(["a"]);
  });
});
