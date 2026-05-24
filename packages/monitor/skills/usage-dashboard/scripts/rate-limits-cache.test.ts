// Run: bun test packages/monitor/skills/usage-dashboard/scripts/rate-limits-cache.test.ts
import { describe, expect, test } from "bun:test";
import { buildRateLimitsRecord } from "./rate-limits-cache";

const NOW = new Date("2026-05-25T00:00:00.000Z");

describe("buildRateLimitsRecord", () => {
  test("returns null for unparseable payload", () => {
    expect(buildRateLimitsRecord("not json", NOW)).toBeNull();
  });

  test("returns null when rate_limits is absent", () => {
    expect(
      buildRateLimitsRecord(JSON.stringify({ model: "x" }), NOW),
    ).toBeNull();
  });

  test("builds a record with injected timestamps when rate_limits present", () => {
    const limits = { primary: { used_percent: 12 } };
    const rec = buildRateLimitsRecord(
      JSON.stringify({ rate_limits: limits }),
      NOW,
    );
    expect(rec).toEqual({
      capturedAt: "2026-05-25T00:00:00.000Z",
      capturedAtEpochMs: NOW.getTime(),
      rate_limits: limits,
    });
  });

  test("treats falsy rate_limits as nothing to cache", () => {
    expect(
      buildRateLimitsRecord(JSON.stringify({ rate_limits: null }), NOW),
    ).toBeNull();
    expect(
      buildRateLimitsRecord(JSON.stringify({ rate_limits: 0 }), NOW),
    ).toBeNull();
  });
});
