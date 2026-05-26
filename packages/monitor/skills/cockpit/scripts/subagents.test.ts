// Tests for the pure sidechain done-detection (subagent liveness).
// Run: bun test packages/monitor/skills/cockpit/scripts/subagents.test.ts
import { describe, expect, test } from "bun:test";
import { sidechainIsDone } from "./subagents";

// An assistant turn line with a given stop_reason.
function assistant(stop: string): string {
  return JSON.stringify({ type: "assistant", message: { stop_reason: stop } });
}
function user(): string {
  return JSON.stringify({ type: "user", message: { content: [] } });
}

describe("sidechainIsDone", () => {
  test("empty / unreadable → not done (a just-spawned agent shouldn't vanish)", () => {
    expect(sidechainIsDone([])).toBe(false);
    expect(sidechainIsDone(["", "  "])).toBe(false);
  });

  test("final assistant turn stopped on end_turn → done", () => {
    expect(
      sidechainIsDone([
        JSON.stringify({ type: "fork-context-ref" }),
        assistant("tool_use"),
        user(),
        assistant("end_turn"),
      ]),
    ).toBe(true);
  });

  test("last assistant turn stopped on tool_use (awaiting a tool) → running", () => {
    expect(
      sidechainIsDone([
        JSON.stringify({ type: "fork-context-ref" }),
        assistant("tool_use"),
      ]),
    ).toBe(false);
  });

  test("last entry is a user tool_result (awaiting next turn) → running", () => {
    expect(sidechainIsDone([assistant("tool_use"), user()])).toBe(false);
  });

  test("trailing bookkeeping lines are skipped to find the real terminal", () => {
    expect(
      sidechainIsDone([
        assistant("end_turn"),
        JSON.stringify({ type: "attachment" }),
        JSON.stringify({ type: "queue-operation" }),
      ]),
    ).toBe(true);
  });

  test("blank and malformed lines don't derail the scan", () => {
    expect(sidechainIsDone(["", "{not json", assistant("end_turn"), ""])).toBe(
      true,
    );
  });
});
