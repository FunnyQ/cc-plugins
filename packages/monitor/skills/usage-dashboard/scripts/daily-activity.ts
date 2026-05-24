// Merge the cached daily-activity series with history-derived day records.
// Extracted from buildStats. The cache (stats-cache.json) is authoritative for
// the days it covers; history.jsonl only *supplements* days that the cache
// doesn't already have AND that fall strictly after the cache's last day — so
// we never override richer cached data or back-fill below it. Pure: takes the
// already-read series + map and returns the merged view + which dates it added.

export type HistoryActivity = {
  messageCount: number;
  sessionIds: Set<string>;
};

export type SupplementalActivity = {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
};

export function mergeDailyActivity<T extends { date: string }>(
  dailyActivity: T[],
  dailyHistory: Map<string, HistoryActivity>,
  lastCachedActivityDate: string | undefined,
): {
  activityByDate: Map<string, T | SupplementalActivity>;
  supplementalHistoryDates: string[];
} {
  const activityByDate = new Map<string, T | SupplementalActivity>(
    dailyActivity.map((d) => [d.date, d]),
  );
  const supplementalHistoryDates: string[] = [];
  for (const [date, historyActivity] of dailyHistory.entries()) {
    if (activityByDate.has(date)) continue;
    if (lastCachedActivityDate && date <= lastCachedActivityDate) continue;
    activityByDate.set(date, {
      date,
      messageCount: historyActivity.messageCount,
      sessionCount: historyActivity.sessionIds.size,
      toolCallCount: 0,
    });
    supplementalHistoryDates.push(date);
  }
  return { activityByDate, supplementalHistoryDates };
}
