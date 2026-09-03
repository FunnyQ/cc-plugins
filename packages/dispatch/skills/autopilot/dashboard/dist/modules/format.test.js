import { describe, expect, test } from "bun:test";
import {
  TOKEN_DANGER,
  TOKEN_WARN,
  allHarnessTokens,
  formatTokens,
  freshTokens,
  hasTokenReading,
  tokenTier,
  totalTokens,
  waveHint,
} from "./format.js";

describe("formatTokens", () => {
  test("reports missing measurements as unavailable, never zero", () => {
    expect(formatTokens(undefined)).toBe("N/A");
    expect(formatTokens(null)).toBe("N/A");
  });

  test("reports non-finite input as unavailable", () => {
    expect(formatTokens(NaN)).toBe("N/A");
    expect(formatTokens(Infinity)).toBe("N/A");
    expect(formatTokens(-Infinity)).toBe("N/A");
  });

  test("reports a negative count as unavailable", () => {
    expect(formatTokens(-1)).toBe("N/A");
  });

  test("renders a real zero as a measured zero", () => {
    expect(formatTokens(0)).toBe("0");
  });

  test("renders the plain integer under 1,000", () => {
    expect(formatTokens(999)).toBe("999");
  });

  test("renders the worked K and M examples", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(8545)).toBe("8.5K");
    expect(formatTokens(278146)).toBe("278.1K");
    expect(formatTokens(7183857)).toBe("7.2M");
  });
});

describe("tokenTier", () => {
  test("tiers on the documented thresholds, inclusive at each step", () => {
    expect(tokenTier(0)).toBe("-normal");
    expect(tokenTier(TOKEN_WARN - 1)).toBe("-normal");
    expect(tokenTier(TOKEN_WARN)).toBe("-warn");
    expect(tokenTier(TOKEN_DANGER - 1)).toBe("-warn");
    expect(tokenTier(TOKEN_DANGER)).toBe("-danger");
    expect(tokenTier(7_183_857)).toBe("-danger");
  });

  test("keeps the thresholds at 60K and 100K", () => {
    expect(TOKEN_WARN).toBe(60_000);
    expect(TOKEN_DANGER).toBe(100_000);
  });

  test("gives no tier to everything formatTokens calls N/A", () => {
    for (const absent of [undefined, null, NaN, Infinity, -Infinity, -1]) {
      expect(formatTokens(absent)).toBe("N/A");
      expect(tokenTier(absent)).toBe("");
      expect(hasTokenReading(absent)).toBe(false);
    }
  });
});

describe("freshTokens", () => {
  const counts = {
    input: 305,
    output: 4795,
    cacheRead: 1_252_822,
    cacheWrite: 44_920,
  };

  // The real verify:foundation/01#2 row. Claude Code's Execute panel read 44.9k for
  // it, which is cacheWrite alone — the billed total is 1.3M and input+output+cacheWrite
  // is 50,020, and neither renders as 44.9k.
  test("is the cache-creation counter alone, matching the harness panel", () => {
    expect(freshTokens(counts)).toBe(44_920);
    expect(formatTokens(freshTokens(counts))).toBe("44.9K");
  });

  test("ignores cache reads, which carry 94-96% of the billed total", () => {
    expect(freshTokens(counts)).not.toBe(totalTokens(counts));
  });

  test("keeps an absent counts object absent, never a measured zero", () => {
    expect(freshTokens(undefined)).toBe(undefined);
    expect(freshTokens(null)).toBe(undefined);
    expect(formatTokens(freshTokens(undefined))).toBe("N/A");
  });

  test("reads a missing or unusable counter as a measured zero", () => {
    expect(freshTokens({ output: 5 })).toBe(0);
    expect(freshTokens({ cacheWrite: "x" })).toBe(0);
    expect(formatTokens(freshTokens({ output: 5 }))).toBe("0");
  });
});

describe("allHarnessTokens", () => {
  const claude = { input: 0, output: 0, cacheRead: 9_000, cacheWrite: 788_700 };
  const codex = { input: 0, output: 0, cacheRead: 9_000, cacheWrite: 488_500 };

  // The header asks "what did this flight cost", not "which side spent what" — that
  // question belongs to the fleet row and the lane card, which keep the two apart.
  test("sums every harness into the one figure the header prints", () => {
    expect(allHarnessTokens(claude, codex)).toBe(1_277_200);
  });

  test("an absent harness contributes zero rather than voiding the total", () => {
    expect(allHarnessTokens(claude, undefined)).toBe(788_700);
    expect(allHarnessTokens(undefined, undefined)).toBe(0);
  });

  test("counts only fresh tokens, never the cache reads beside them", () => {
    expect(allHarnessTokens(claude)).toBe(claude.cacheWrite);
  });
});

describe("totalTokens", () => {
  test("sums all four billed counters", () => {
    expect(
      totalTokens({ input: 1, output: 20, cacheRead: 300, cacheWrite: 4000 }),
    ).toBe(4321);
  });

  test("keeps an absent counts object absent, never a measured zero", () => {
    expect(totalTokens(undefined)).toBe(undefined);
    expect(totalTokens(null)).toBe(undefined);
    expect(formatTokens(totalTokens(undefined))).toBe("N/A");
  });

  test("renders a fully zero reading as a measured zero", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(totalTokens(zero)).toBe(0);
    expect(formatTokens(totalTokens(zero))).toBe("0");
  });

  test("treats a missing or unusable counter as nothing, not as NaN", () => {
    expect(totalTokens({ output: 5 })).toBe(5);
    expect(totalTokens({ input: "x", output: 5 })).toBe(5);
  });
});

// The panels that carry no thresholds still have to tell a measured 0 from an
// unknown, so the presence test is shared rather than re-derived per panel.
describe("hasTokenReading", () => {
  test("accepts every count formatTokens prints a number for", () => {
    for (const present of [0, 1, 999, 92_400, 7_183_857]) {
      expect(hasTokenReading(present)).toBe(true);
      expect(formatTokens(present)).not.toBe("N/A");
    }
  });
});

describe("waveHint", () => {
  test("says the count includes the wave in flight", () => {
    expect(
      waveHint({ current: 2, remaining: 2, sizes: [3, 1], unschedulable: [] }),
    ).toBe(
      "Wave 2 in flight · 2 waves left, counting the one in flight: 3 → 1 tasks",
    );
  });

  test("drops the wave number before the first scout", () => {
    expect(
      waveHint({ current: 0, remaining: 1, sizes: [4], unschedulable: [] }),
    ).toBe("1 wave left, counting the one in flight: 4 tasks");
  });

  test("names the tasks no wave can reach", () => {
    expect(
      waveHint({
        current: 1,
        remaining: 0,
        sizes: [],
        unschedulable: ["api/01", "api/02"],
      }),
    ).toBe(
      "Wave 1 in flight · No waves left to fly · 2 task(s) no wave can reach: api/01, api/02",
    );
  });

  test("survives a payload with no wave field at all", () => {
    expect(waveHint(undefined)).toBe("No waves left to fly");
  });
});
