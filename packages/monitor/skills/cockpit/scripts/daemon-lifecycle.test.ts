// Run: bun test packages/monitor/skills/cockpit/scripts/daemon-lifecycle.test.ts
import { test, expect, describe } from "bun:test";
import { decideStartup, type DaemonInfo } from "./daemon-lifecycle";

const ROOT = "/install/a/scripts";
const alive = () => true;
const dead = () => false;

const info = (over: Partial<DaemonInfo> = {}): DaemonInfo => ({
  pid: 1234,
  port: 5858,
  token: "tok",
  root: ROOT,
  ...over,
});

describe("decideStartup", () => {
  test("no record → start fresh", () => {
    expect(decideStartup(null, ROOT, alive)).toEqual({ action: "start" });
  });

  test("recorded pid is dead → start fresh", () => {
    expect(decideStartup(info(), ROOT, dead)).toEqual({ action: "start" });
  });

  test("missing pid → start fresh", () => {
    expect(decideStartup({ port: 5858 }, ROOT, alive)).toEqual({
      action: "start",
    });
  });

  test("alive daemon from the same install → reuse", () => {
    const d = decideStartup(info(), ROOT, alive);
    expect(d.action).toBe("reuse");
    if (d.action === "reuse") expect(d.info.pid).toBe(1234);
  });

  test("alive daemon from a different root → supersede (moved/updated install)", () => {
    const d = decideStartup(info({ root: "/install/b/scripts" }), ROOT, alive);
    expect(d.action).toBe("supersede");
  });

  test("alive daemon with no root field (pre-fix daemon) → supersede", () => {
    const { root, ...legacy } = info();
    const d = decideStartup(legacy, ROOT, alive);
    expect(d.action).toBe("supersede");
  });
});
