import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeFile,
  capDiff,
  isBinaryFile,
  parseStatusLine,
  shouldSkipDiff,
  unquoteGitPath,
} from "./analyze-changes";

describe("parseStatusLine", () => {
  test("parses untracked files as unstaged additions", () => {
    expect(parseStatusLine("?? f")).toEqual([
      { path: "f", staged: false, status: "added" },
    ]);
  });

  test("parses staged additions", () => {
    expect(parseStatusLine("A  f")).toEqual([
      { path: "f", staged: true, status: "added" },
    ]);
  });

  test("parses combined staged and unstaged modifications", () => {
    expect(parseStatusLine("MM f")).toEqual([
      { path: "f", staged: true, status: "modified" },
      { path: "f", staged: false, status: "modified" },
    ]);
  });

  test("parses renames with oldPath", () => {
    expect(parseStatusLine("R  old -> new")).toEqual([
      { path: "new", oldPath: "old", staged: true, status: "renamed" },
    ]);
  });

  test("parses deletions", () => {
    expect(parseStatusLine(" D f")).toEqual([
      { path: "f", staged: false, status: "deleted" },
    ]);
  });

  test("ignores short lines", () => {
    expect(parseStatusLine("M")).toEqual([]);
  });
});

describe("unquoteGitPath", () => {
  test("leaves plain paths unchanged", () => {
    expect(unquoteGitPath("src/a.ts")).toBe("src/a.ts");
  });

  test("unquotes JSON-compatible quoted paths", () => {
    expect(unquoteGitPath('"path with spaces.txt"')).toBe(
      "path with spaces.txt",
    );
  });

  test("falls back to slicing malformed quoted paths", () => {
    expect(unquoteGitPath('"bad\\xpath"')).toBe("bad\\xpath");
  });
});

describe("shouldSkipDiff", () => {
  test("skips lock files and node_modules", () => {
    expect(shouldSkipDiff("bun.lockb")).toBe(true);
    expect(shouldSkipDiff("package-lock.json")).toBe(true);
    expect(shouldSkipDiff("node_modules/x")).toBe(true);
  });

  test("does not skip normal source files", () => {
    expect(shouldSkipDiff("src/a.ts")).toBe(false);
  });
});

describe("isBinaryFile", () => {
  test("detects binary extensions", () => {
    expect(isBinaryFile("image.png")).toBe(true);
    expect(isBinaryFile("font.woff2")).toBe(true);
  });

  test("treats extensions case-insensitively", () => {
    expect(isBinaryFile("IMAGE.PNG")).toBe(true);
  });

  test("does not flag TypeScript files", () => {
    expect(isBinaryFile("src/a.ts")).toBe(false);
  });
});

describe("capDiff", () => {
  test("keeps short diffs unchanged", () => {
    expect(capDiff("one\ntwo", { insertions: 1, deletions: 1 })).toBe(
      "one\ntwo",
    );
  });

  test("truncates long diffs with total stats", () => {
    const diff = Array.from(
      { length: 402 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");

    const capped = capDiff(diff, { insertions: 12, deletions: 3 });

    expect(capped.split("\n")).toHaveLength(401);
    expect(capped).toEndWith(
      "[diff truncated: 400 of 402 lines shown; +12/-3 total]",
    );
  });
});

describe("analyzeFile", () => {
  test("marks unreadable files without throwing", async () => {
    const result = await analyzeFile({
      path: "/tmp/chronicle-missing-file.txt",
      staged: false,
      status: "added",
    });

    expect(result.diff).toBe("[unreadable - skipped]");
  });

  test("skips inline content for large untracked files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chronicle-large-"));
    const path = join(dir, "large.txt");
    await writeFile(path, `${"line\n".repeat(70_000)}`);

    const result = await analyzeFile({
      path,
      staged: false,
      status: "added",
    });

    expect(result.diff).toContain("[large file - content skipped]");
    expect(result.diff).not.toContain("line\nline\nline");
    expect(result.insertions).toBe(70_000);
  });
});
