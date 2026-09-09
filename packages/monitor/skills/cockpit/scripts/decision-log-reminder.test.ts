import { describe, expect, it } from "bun:test";
import {
  resolveParentSession,
  shouldSkipDecisionLogReminder,
} from "./decision-log-reminder";

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

describe("resolveParentSession", () => {
  const finder = (calls: Array<[string, string]>) => (p: string, c: string) => {
    calls.push([p, c]);
    return "resolved-id";
  };

  it("resolves through the same finder the skill would call", () => {
    const calls: Array<[string, string]> = [];
    expect(
      resolveParentSession({}, { cwd: "/repo" }, finder(calls) as never),
    ).toBe("resolved-id");
    expect(calls).toEqual([["claude", "/repo"]]);
  });

  it("resolves against codex when PLUGIN_ROOT marks the harness", () => {
    const calls: Array<[string, string]> = [];
    expect(
      resolveParentSession(
        { PLUGIN_ROOT: "/plugins/monitor" },
        { cwd: "/repo" },
        finder(calls) as never,
      ),
    ).toBe("resolved-id");
    expect(calls).toEqual([["codex", "/repo"]]);
  });

  it("trusts OpenCode's own id — a directory lookup can hit a sibling session", () => {
    const calls: Array<[string, string]> = [];
    expect(
      resolveParentSession(
        {},
        { cwd: "/repo", session_id: "ses_abc", provider: "opencode" },
        finder(calls) as never,
      ),
    ).toBe("ses_abc");
    expect(calls).toEqual([]);
  });

  it("falls back to the hook's own session id", () => {
    expect(
      resolveParentSession({}, { cwd: "/repo", session_id: "s1" }, () => null),
    ).toBe("s1");
    expect(
      resolveParentSession({}, { cwd: "/repo", session_id: "s1" }, () => {
        throw new Error("boom");
      }),
    ).toBe("s1");
  });

  it("returns null when nothing resolves", () => {
    expect(resolveParentSession({}, { cwd: "/repo" }, () => null)).toBe(null);
  });
});
