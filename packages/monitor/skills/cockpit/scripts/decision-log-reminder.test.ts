import { describe, expect, it } from "bun:test";
import { shouldSkipDecisionLogReminder } from "./decision-log-reminder";

describe("shouldSkipDecisionLogReminder", () => {
  it("skips relay-delegated sessions", () => {
    expect(shouldSkipDecisionLogReminder({ RELAY_DELEGATED: "1" }, {})).toBe(
      true,
    );
  });

  it("skips Claude SDK and headless sessions", () => {
    expect(
      shouldSkipDecisionLogReminder({ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, {}),
    ).toBe(true);
    expect(
      shouldSkipDecisionLogReminder(
        { CLAUDE_CODE_ENTRYPOINT: "sdk-typescript" },
        {},
      ),
    ).toBe(true);
  });

  it("skips subagents even inside an interactive session", () => {
    expect(
      shouldSkipDecisionLogReminder(
        { CLAUDE_CODE_ENTRYPOINT: "cli" },
        { agent_id: "agent-123" },
      ),
    ).toBe(true);
  });

  it("skips an already-active Stop hook", () => {
    expect(
      shouldSkipDecisionLogReminder(
        {},
        { hook_event_name: "Stop", stop_hook_active: true },
      ),
    ).toBe(true);
  });

  it("keeps reminders for an interactive main session", () => {
    expect(
      shouldSkipDecisionLogReminder({ CLAUDE_CODE_ENTRYPOINT: "cli" }, {}),
    ).toBe(false);
  });
});
