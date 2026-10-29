import { expect, test } from "bun:test";
import { defaultStateDir } from "./ledger.ts";

test("off win32 the state dir stays the literal /tmp/q-lab/guard", () => {
  expect(defaultStateDir("darwin", "/var/x")).toBe("/tmp/q-lab/guard");
  expect(defaultStateDir("linux", "/whatever")).toBe("/tmp/q-lab/guard");
});

// windows.md: `\tmp\x` is drive-relative, so win32 roots under the user's temp dir.
test("on win32 the state dir lies under the given temp dir", () => {
  expect(defaultStateDir("win32", "C:\\Users\\me\\AppData\\Local\\Temp")).toBe(
    "C:\\Users\\me\\AppData\\Local\\Temp\\q-lab\\guard",
  );
});
