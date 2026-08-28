import { describe, expect, test } from "bun:test";
import { formatTokens } from "./format.js";

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
