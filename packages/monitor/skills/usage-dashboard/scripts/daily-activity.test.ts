// Run: bun test packages/monitor/skills/usage-dashboard/scripts/daily-activity.test.ts
import { describe, expect, test } from "bun:test";
import { mergeDailyActivity, type HistoryActivity } from "./daily-activity";

const hist = (messageCount: number, sessions: string[]): HistoryActivity => ({
  messageCount,
  sessionIds: new Set(sessions),
});

describe("mergeDailyActivity", () => {
  test("keeps all cached days as-is", () => {
    const cached = [{ date: "2026-05-20", messageCount: 5 }];
    const { activityByDate, supplementalHistoryDates } = mergeDailyActivity(
      cached,
      new Map(),
      "2026-05-20",
    );
    expect(activityByDate.get("2026-05-20")).toBe(cached[0]);
    expect(supplementalHistoryDates).toEqual([]);
  });

  test("supplements only history days strictly after the last cached day", () => {
    const cached = [{ date: "2026-05-20" }];
    const history = new Map([
      ["2026-05-19", hist(2, ["a"])], // before cache → ignored
      ["2026-05-20", hist(2, ["a"])], // == last cached → ignored
      ["2026-05-21", hist(3, ["a", "b"])], // after → supplemented
    ]);
    const { activityByDate, supplementalHistoryDates } = mergeDailyActivity(
      cached,
      history,
      "2026-05-20",
    );
    expect(supplementalHistoryDates).toEqual(["2026-05-21"]);
    expect(activityByDate.get("2026-05-21")).toEqual({
      date: "2026-05-21",
      messageCount: 3,
      sessionCount: 2, // Set size, not raw count
      toolCallCount: 0,
    });
    expect(activityByDate.has("2026-05-19")).toBe(false);
  });

  test("never overrides a cached day even if history also has it", () => {
    const cached = [{ date: "2026-05-21", messageCount: 99 }];
    const history = new Map([["2026-05-21", hist(1, ["x"])]]);
    const { activityByDate, supplementalHistoryDates } = mergeDailyActivity(
      cached,
      history,
      "2026-05-20",
    );
    expect(activityByDate.get("2026-05-21")).toEqual({
      date: "2026-05-21",
      messageCount: 99,
    });
    expect(supplementalHistoryDates).toEqual([]);
  });

  test("with no cached days, all history days are supplemented", () => {
    const history = new Map([["2026-05-21", hist(1, ["x"])]]);
    const { supplementalHistoryDates } = mergeDailyActivity(
      [],
      history,
      undefined,
    );
    expect(supplementalHistoryDates).toEqual(["2026-05-21"]);
  });
});
