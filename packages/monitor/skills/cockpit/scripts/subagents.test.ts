// Tests for the pure sidechain done-detection (subagent liveness).
// Shapes mirror real ~/.claude sidechain transcripts: a final assistant turn
// stops on "end_turn" OR null depending on version, followed by SubagentStop
// hook_progress entries when that hook is configured.
// Run: bun test packages/monitor/skills/cockpit/scripts/subagents.test.ts
import { describe, expect, test } from "bun:test";
import { sidechainIsDone } from "./subagents";

// An assistant turn line. `content` defaults to a plain text answer (no tool).
function assistant(
  stop: string | null,
  content: { type: string }[] = [{ type: "text" }],
): string {
  return JSON.stringify({
    type: "assistant",
    message: { stop_reason: stop, content },
  });
}
function user(): string {
  return JSON.stringify({ type: "user", message: { content: [] } });
}
// The SubagentStop hook_progress entry that tails a completed sidechain.
function subagentStop(): string {
  return JSON.stringify({
    type: "progress",
    data: { type: "hook_progress", hookEvent: "SubagentStop" },
  });
}

describe("sidechainIsDone", () => {
  test("empty / unreadable → not done (a just-spawned agent shouldn't vanish)", () => {
    expect(sidechainIsDone([])).toBe(false);
    expect(sidechainIsDone(["", "  "])).toBe(false);
  });

  test("final assistant on end_turn → done", () => {
    expect(
      sidechainIsDone([
        JSON.stringify({ type: "fork-context-ref" }),
        assistant("tool_use", [{ type: "tool_use" }]),
        user(),
        assistant("end_turn"),
      ]),
    ).toBe(true);
  });

  // The bug the review caught: real completed sidechains often end on a
  // null-stopped assistant followed by SubagentStop, not end_turn.
  test("null-stopped final assistant + SubagentStop tail → done", () => {
    expect(
      sidechainIsDone([assistant(null), subagentStop(), subagentStop()]),
    ).toBe(true);
  });

  test("SubagentStop is authoritative even past trailing progress", () => {
    expect(sidechainIsDone([assistant("end_turn"), subagentStop()])).toBe(true);
  });

  test("null-stopped plain answer (no hook) → done via terminal fallback", () => {
    expect(sidechainIsDone([user(), assistant(null)])).toBe(true);
  });

  test("non-tool stop reasons (stop_sequence, max_tokens) → done", () => {
    expect(sidechainIsDone([assistant("stop_sequence")])).toBe(true);
    expect(sidechainIsDone([assistant("max_tokens")])).toBe(true);
  });

  test("assistant still holding a tool_use call → running", () => {
    expect(sidechainIsDone([assistant(null, [{ type: "tool_use" }])])).toBe(
      false,
    );
    expect(
      sidechainIsDone([assistant("tool_use", [{ type: "tool_use" }])]),
    ).toBe(false);
  });

  test("last entry is a user tool_result (awaiting next turn) → running", () => {
    expect(
      sidechainIsDone([assistant("tool_use", [{ type: "tool_use" }]), user()]),
    ).toBe(false);
  });

  test("blank and malformed lines don't derail the scan", () => {
    expect(sidechainIsDone(["", "{not json", assistant("end_turn"), ""])).toBe(
      true,
    );
  });
});
