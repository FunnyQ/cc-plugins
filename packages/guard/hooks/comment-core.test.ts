import { expect, test } from "bun:test";
import { isGuardedPath } from "./comment-core.ts";

test("docs, vendor and node_modules segments separated by a backslash are skipped", () => {
  expect(isGuardedPath("docs\\gen.py")).toBe(false);
  expect(isGuardedPath("C:\\repo\\vendor\\x.js")).toBe(false);
  expect(isGuardedPath("a\\node_modules\\y.ts")).toBe(false);
});

test("a backslash path skips by segment, not substring", () => {
  expect(isGuardedPath("mydocs\\gen.py")).toBe(true);
});
