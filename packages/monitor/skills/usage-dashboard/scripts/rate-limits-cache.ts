// Pure parsing for the statusline collector's rate-limit cache. Extracted from
// statusline-collector.ts (whose top level reads stdin + spawns a subprocess
// and so can't be imported in a test) so the "only cache when rate_limits are
// present" rule is unit-testable.

export type RateLimitsRecord = {
  capturedAt: string;
  capturedAtEpochMs: number;
  rate_limits: unknown;
};

type StatuslinePayload = {
  rate_limits?: unknown;
};

// Build the cache record for a statusline payload, or null when there's nothing
// worth caching (unparseable JSON, or no rate_limits field). `now` is injected
// so the timestamps are deterministic in tests.
export function buildRateLimitsRecord(
  payload: string,
  now: Date = new Date(),
): RateLimitsRecord | null {
  let parsed: StatuslinePayload;
  try {
    parsed = JSON.parse(payload) as StatuslinePayload;
  } catch {
    return null;
  }
  if (!parsed.rate_limits) return null;
  return {
    capturedAt: now.toISOString(),
    capturedAtEpochMs: now.getTime(),
    rate_limits: parsed.rate_limits,
  };
}
