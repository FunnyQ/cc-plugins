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

  describe("codex delegation marker", () => {
    const stub = (delegated: boolean) => ({
      isDelegated: () => delegated,
      now: () => 1_000,
    });

    it("skips a codex session that a marker claims", () => {
      expect(
        shouldSkipDecisionLogReminder(
          { PLUGIN_ROOT: "/plugins/monitor" },
          { cwd: "/repo", session_id: "s1" },
          stub(true),
        ),
      ).toBe(true);
    });

    it("keeps reminders for an unclaimed codex session", () => {
      expect(
        shouldSkipDecisionLogReminder(
          { PLUGIN_ROOT: "/plugins/monitor" },
          { cwd: "/repo", session_id: "s1" },
          stub(false),
        ),
      ).toBe(false);
    });

    it("never consults the marker on Claude Code", () => {
      let consulted = false;
      const spy = {
        isDelegated: () => {
          consulted = true;
          return true;
        },
        now: () => 1_000,
      };
      expect(
        shouldSkipDecisionLogReminder(
          { CLAUDE_CODE_ENTRYPOINT: "cli" },
          { cwd: "/repo", session_id: "s1" },
          spy,
        ),
      ).toBe(false);
      expect(consulted).toBe(false);
    });

    it("keeps reminders when the marker store throws", () => {
      expect(
        shouldSkipDecisionLogReminder(
          { PLUGIN_ROOT: "/plugins/monitor" },
          { cwd: "/repo", session_id: "s1" },
          {
            isDelegated: () => {
              throw new Error("boom");
            },
            now: () => 1_000,
          },
        ),
      ).toBe(false);
    });
  });
});
