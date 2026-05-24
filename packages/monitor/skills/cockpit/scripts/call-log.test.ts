// Tests for the pure decision-log scanner shared by broker + CLI.
// Run: bun test packages/monitor/skills/cockpit/scripts/call-log.test.ts
import { describe, expect, test } from "bun:test";
import { callMatches, latestOpenCallId } from "./call-log";

const goal = JSON.stringify({ type: "goal", session_goal: "g" });
const call = (id: string, needs = true) =>
  JSON.stringify({ type: "decision", id, needs_your_call: needs });
const plain = (id: string) =>
  JSON.stringify({ type: "decision", id, needs_your_call: false });
const response = (callId: string | null = null) =>
  JSON.stringify({ type: "response", call: callId, answer: "ok" });

describe("latestOpenCallId", () => {
  test("returns null for an empty / goal-only log", () => {
    expect(latestOpenCallId([])).toBeNull();
    expect(latestOpenCallId([goal])).toBeNull();
  });

  test("returns the id of an open needs_your_call", () => {
    expect(latestOpenCallId([goal, call("c1")])).toBe("c1");
  });

  test("a plain decision is not an open call", () => {
    expect(latestOpenCallId([goal, plain("d1")])).toBeNull();
  });

  test("a response after the call closes it", () => {
    expect(latestOpenCallId([goal, call("c1"), response("c1")])).toBeNull();
  });

  test("returns the latest open call when several exist", () => {
    // c1 answered, c2 still open → c2 is the open one.
    const lines = [goal, call("c1"), response("c1"), call("c2")];
    expect(latestOpenCallId(lines)).toBe("c2");
  });

  test("the most recent response wins even if earlier calls are open-looking", () => {
    const lines = [goal, call("c1"), call("c2"), response("c2")];
    expect(latestOpenCallId(lines)).toBeNull();
  });

  test("answering an older (superseded) call leaves the latest call open", () => {
    // c2 supersedes c1; a stray answer to c1 (e.g. `send --call c1`) must not
    // close c2 nor be misread as "no open call".
    const lines = [goal, call("c1"), call("c2"), response("c1")];
    expect(latestOpenCallId(lines)).toBe("c2");
  });

  test("answering the latest call does NOT reopen the older superseded one", () => {
    // Once c2 supersedes c1, answering c2 closes the trail — c1 never reopens.
    const lines = [goal, call("c1"), call("c2"), response("c2")];
    expect(latestOpenCallId(lines)).toBeNull();
  });

  test("a legacy response without a call closes the latest open call", () => {
    const lines = [goal, call("c1"), call("c2"), response(null)];
    expect(latestOpenCallId(lines)).toBeNull();
  });

  test("skips blank and malformed lines", () => {
    expect(latestOpenCallId(["", "  ", "not json", call("c1")])).toBe("c1");
  });
});

describe("callMatches", () => {
  test("equal ids match", () => {
    expect(callMatches("c1", "c1")).toBe(true);
  });
  test("different ids do not match", () => {
    expect(callMatches("c1", "c2")).toBe(false);
  });
  test("a null on either side is tolerated (legacy session-only routing)", () => {
    expect(callMatches(null, "c1")).toBe(true);
    expect(callMatches("c1", null)).toBe(true);
    expect(callMatches(null, null)).toBe(true);
    expect(callMatches(undefined, "c1")).toBe(true);
  });
});
