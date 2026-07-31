import { describe, expect, test } from "bun:test";
import type { DaemonInfo } from "./daemon-record";
import { decideStartup } from "./daemon-decision";

const me = { root: "/install", plan: "/plan", port: 5757 };
const matching: DaemonInfo = { pid: 42, ...me };

describe("decideStartup", () => {
  test("starts without a record or with a dead pid", () => {
    expect(decideStartup(null, me, () => false)).toEqual({ action: "start" });
    expect(decideStartup(matching, me, () => false)).toEqual({ action: "start" });
  });

  test("supersedes a server from a moved install", () => {
    const info = { ...matching, root: "/old-install" };
    expect(decideStartup(info, me, () => true)).toEqual({
      action: "supersede",
      info,
      reason: "moved-install",
    });
  });

  test("supersedes a server for a different plan", () => {
    const info = { ...matching, plan: "/other-plan" };
    expect(decideStartup(info, me, () => true)).toEqual({
      action: "supersede",
      info,
      reason: "different-plan",
    });
  });

  test("supersedes a matching server for a port override", () => {
    const info = { ...matching, port: 6000 };
    expect(decideStartup(info, me, () => true)).toEqual({
      action: "supersede",
      info,
      reason: "port-change",
    });
  });

  test("reuses a matching server", () => {
    expect(decideStartup(matching, me, () => true)).toEqual({
      action: "reuse",
      info: matching,
    });
  });
});
