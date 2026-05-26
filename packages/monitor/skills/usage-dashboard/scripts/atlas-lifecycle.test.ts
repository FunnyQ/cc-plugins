// Run: bun test packages/monitor/skills/usage-dashboard/scripts/atlas-lifecycle.test.ts
import { test, expect, describe } from "bun:test";
import { decideStartup, type AtlasInfo } from "./atlas-lifecycle";

const ROOT = "/install/a/scripts";
const alive = () => true;
const dead = () => false;

const info = (over: Partial<AtlasInfo> = {}): AtlasInfo => ({
  pid: 1234,
  port: 5938,
  root: ROOT,
  ...over,
});

describe("decideStartup", () => {
  test("no record -> start fresh", () => {
    expect(decideStartup(null, ROOT, alive)).toEqual({ action: "start" });
  });

  test("recorded pid is dead -> start fresh", () => {
    expect(decideStartup(info(), ROOT, dead)).toEqual({ action: "start" });
  });

  test("missing pid -> start fresh", () => {
    expect(decideStartup({ port: 5938 }, ROOT, alive)).toEqual({
      action: "start",
    });
  });

  test("alive atlas from the same install -> reuse", () => {
    const d = decideStartup(info(), ROOT, alive);
    expect(d.action).toBe("reuse");
    if (d.action === "reuse") expect(d.info.pid).toBe(1234);
  });

  test("alive atlas from a different root -> supersede", () => {
    const d = decideStartup(info({ root: "/install/b/scripts" }), ROOT, alive);
    expect(d.action).toBe("supersede");
  });

  test("alive atlas with no root field -> supersede", () => {
    const { root, ...legacy } = info();
    const d = decideStartup(legacy, ROOT, alive);
    expect(d.action).toBe("supersede");
  });
});
