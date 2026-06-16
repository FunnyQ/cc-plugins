// Tests for the cockpit diagram theme. The point isn't to pixel-check Mermaid
// (that's DOM-bound) but to guard two invariants: diagram.js stays importable
// under plain Bun (no static DOM imports at module top level — render-time deps
// are loaded lazily), and the Night Flight theme feeds Mermaid concrete colours
// its khroma engine can parse (hex, never oklch()).
// Run: bun test packages/monitor/skills/cockpit/scripts/diagram-theme.test.ts
import { describe, expect, test } from "bun:test";
import { NIGHT_FLIGHT_THEME } from "../dashboard/dist/modules/diagram.js";

describe("NIGHT_FLIGHT_THEME", () => {
  test("every colour seed is concrete hex (khroma can't parse oklch)", () => {
    const colorKeys = Object.keys(NIGHT_FLIGHT_THEME).filter(
      (k) =>
        typeof NIGHT_FLIGHT_THEME[k] === "string" &&
        /color|bkg|border|line|background|text/i.test(k),
    );
    expect(colorKeys.length).toBeGreaterThan(5);
    for (const k of colorKeys) {
      const v = NIGHT_FLIGHT_THEME[k];
      // hex (optionally with alpha) or the one allowed keyword
      expect(
        v === "transparent" || /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v),
      ).toBe(true);
      expect(v).not.toContain("oklch");
      expect(v).not.toContain("var(");
    }
  });

  test("carries the Night Flight identity colours", () => {
    expect(NIGHT_FLIGHT_THEME.darkMode).toBe(true);
    expect(NIGHT_FLIGHT_THEME.background).toBe("transparent");
    // aurora is the cool navigation accent → primary node border
    expect(NIGHT_FLIGHT_THEME.primaryBorderColor).toBe("#2ad7d7");
    // starlight ink, never pure white
    expect(NIGHT_FLIGHT_THEME.primaryTextColor).toBe("#edeef4");
  });
});
