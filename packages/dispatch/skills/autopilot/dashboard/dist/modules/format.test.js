import { describe, expect, test } from "bun:test";
import {
  TOKEN_DANGER,
  TOKEN_WARN,
  formatTokens,
  hasTokenReading,
  tokenTier,
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

  test("keeps the thresholds at 80K and 200K", () => {
    expect(TOKEN_WARN).toBe(80_000);
    expect(TOKEN_DANGER).toBe(200_000);
  });

  test("gives no tier to everything formatTokens calls N/A", () => {
    for (const absent of [undefined, null, NaN, Infinity, -Infinity, -1]) {
      expect(formatTokens(absent)).toBe("N/A");
      expect(tokenTier(absent)).toBe("");
      expect(hasTokenReading(absent)).toBe(false);
    }
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
