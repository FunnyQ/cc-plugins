import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "dashboard", "dist");

function classes(selectorList: string): string[] {
  return selectorList
    .split(",")
    .map((s) => s.trim().replace(/::?[a-z-]+$/, ""))
    .sort();
}

test("every bloom-lit class is in both the panels.css glow rule and installBloomTracker's SELECTOR", () => {
  const css = readFileSync(join(dist, "styles", "panels.css"), "utf8");
  const glow = css.match(/([^{}]+)\{[^{}]*var\(--bloom-x/);
  const js = readFileSync(join(dist, "modules", "bloom-tracker.js"), "utf8");
  const selector = js.match(/const SELECTOR =\s*"([^"]+)"/);
  expect(glow).not.toBeNull();
  expect(selector).not.toBeNull();
  expect(classes(glow![1])).toEqual(classes(selector![1]));
});
