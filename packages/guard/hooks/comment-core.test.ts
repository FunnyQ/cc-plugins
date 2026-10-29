import { expect, test } from "bun:test";
import { baseName, extName, isGuardedPath, syntaxFor } from "./comment-core.ts";

test("docs, vendor and node_modules segments separated by a backslash are skipped", () => {
  expect(isGuardedPath("docs\\gen.py")).toBe(false);
  expect(isGuardedPath("C:\\repo\\vendor\\x.js")).toBe(false);
  expect(isGuardedPath("a\\node_modules\\y.ts")).toBe(false);
});

test("a backslash path skips by segment, not substring", () => {
  expect(isGuardedPath("mydocs\\gen.py")).toBe(true);
});

for (const name of ["Dockerfile", "Dockerfile.dev", "Gemfile", "Makefile"]) {
  test(`Windows paths detect ${name} syntax`, () => {
    const path = `C:\\repo\\${name}`;
    expect(baseName(path)).toBe(name);
    expect(baseName(`${path}\\`)).toBe(name);
    expect(syntaxFor(path)).toEqual({ line: ["#"], block: [] });
    expect(isGuardedPath(path)).toBe(true);
  });
}

test("Windows directory dots do not become file extensions", () => {
  expect(extName("C:\\repo.d\\Dockerfile")).toBe("");
  expect(syntaxFor("C:\\repo.d\\LICENSE")).toBeNull();
});
