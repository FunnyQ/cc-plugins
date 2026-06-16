// Tests for the restart classifier — the decision that drives `cockpit restart`'s
// supersede-and-retry loop. Run: bun test packages/monitor/skills/cockpit/scripts/restart-lifecycle.test.ts
import { describe, expect, test } from "bun:test";
import { classifyDaemon } from "./restart-lifecycle";

const MY_ROOT = "/cache/monitor/3.12.0/skills/cockpit/scripts";
const alive = () => true;
const dead = () => false;

describe("classifyDaemon", () => {
  test("no daemon record → absent", () => {
    expect(classifyDaemon(null, MY_ROOT, alive)).toBe("absent");
  });

  test("record with no pid → absent", () => {
    expect(classifyDaemon({ root: MY_ROOT }, MY_ROOT, alive)).toBe("absent");
  });

  test("dead pid → absent (even if root matches)", () => {
    expect(classifyDaemon({ pid: 999, root: MY_ROOT }, MY_ROOT, dead)).toBe(
      "absent",
    );
  });

  test("alive & same root → ours", () => {
    expect(classifyDaemon({ pid: 123, root: MY_ROOT }, MY_ROOT, alive)).toBe(
      "ours",
    );
  });

  test("alive & different root → foreign (the old-cache respawn case)", () => {
    const old = "/cache/monitor/3.11.0/skills/cockpit/scripts";
    expect(classifyDaemon({ pid: 123, root: old }, MY_ROOT, alive)).toBe(
      "foreign",
    );
  });

  test("alive but root absent → foreign (legacy daemon, can't prove it's ours)", () => {
    expect(classifyDaemon({ pid: 123 }, MY_ROOT, alive)).toBe("foreign");
  });
});
