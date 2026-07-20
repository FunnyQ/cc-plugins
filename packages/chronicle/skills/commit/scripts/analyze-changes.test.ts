import { $ } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeFile,
  applyTotalDiffBudget,
  capDiff,
  isBinaryFile,
  parseNumstat,
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

describe("parseNumstat", () => {
  test("reads insertions and deletions", () => {
    expect(parseNumstat("12\t3\tsrc/a.ts")).toEqual({
      insertions: 12,
      deletions: 3,
    });
  });

  test("treats binary markers as zero", () => {
    expect(parseNumstat("-\t-\timage.png")).toEqual({
      insertions: 0,
      deletions: 0,
    });
  });

  test("treats empty output as zero", () => {
    expect(parseNumstat("")).toEqual({ insertions: 0, deletions: 0 });
  });
});

describe("applyTotalDiffBudget", () => {
  const file = (path: string, lines: number, stats = { i: 1, d: 1 }) => ({
    path,
    staged: false,
    status: "modified" as const,
    diff: Array.from({ length: lines }, (_, n) => `line ${n}`).join("\n"),
    insertions: stats.i,
    deletions: stats.d,
  });

  test("leaves a changeset under budget untouched", () => {
    const files = [file("a.ts", 10), file("b.ts", 10)];

    expect(applyTotalDiffBudget(files, 100)).toEqual(files);
  });

  test("drops the largest diffs first until under budget", () => {
    const result = applyTotalDiffBudget(
      [file("small.ts", 10), file("huge.ts", 500), file("mid.ts", 60)],
      100,
    );

    expect(result[1].diff).toContain("[diff omitted:");
    expect(result[1].diff).toContain("100-line aggregate budget");
    expect(result[0].diff).not.toContain("[diff omitted:");
    expect(result[2].diff).not.toContain("[diff omitted:");
  });

  test("preserves original file order and stats when trimming", () => {
    const result = applyTotalDiffBudget(
      [file("a.ts", 500, { i: 400, d: 100 }), file("b.ts", 5)],
      50,
    );

    expect(result.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(result[0].insertions).toBe(400);
    expect(result[0].deletions).toBe(100);
    expect(result[0].diff).toContain("+400/-100");
  });

  test("keeps trimming when every diff is oversized", () => {
    const result = applyTotalDiffBudget(
      [file("a.ts", 300), file("b.ts", 300)],
      50,
    );

    expect(result.every((f) => f.diff.startsWith("[diff omitted:"))).toBe(true);
  });
});

describe("analyzeFile", () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  test("reports real diff stats for a tracked lock file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chronicle-lock-"));
    process.chdir(dir);
    await $`git init -q .`.quiet();
    await $`git config user.email t@t`.quiet();
    await $`git config user.name t`.quiet();

    // 100-line lock file, of which only 4 lines change
    await writeFile(
      join(dir, "bun.lock"),
      `${Array.from({ length: 100 }, (_, n) => `"pkg-${n}": "1.0.0",`).join("\n")}\n`,
    );
    await $`git add -A`.quiet();
    await $`git -c commit.gpgSign=false commit -qm init`.quiet();
    await writeFile(
      join(dir, "bun.lock"),
      `${Array.from({ length: 100 }, (_, n) =>
        n < 4 ? `"pkg-${n}": "2.0.0",` : `"pkg-${n}": "1.0.0",`,
      ).join("\n")}\n`,
    );

    const result = await analyzeFile({
      path: "bun.lock",
      staged: false,
      status: "modified",
    });

    expect(result.diff).toBe("[lock file - diff skipped]");
    // the regression: this used to report the whole file (100) as insertions
    expect(result.insertions).toBe(4);
    expect(result.deletions).toBe(4);
  });

  test("falls back to file length for an untracked lock file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chronicle-newlock-"));
    process.chdir(dir);
    await $`git init -q .`.quiet();
    await writeFile(join(dir, "bun.lock"), "a\nb\nc\n");

    const result = await analyzeFile({
      path: "bun.lock",
      staged: false,
      status: "added",
    });

    expect(result.diff).toBe("[lock file - diff skipped]");
    expect(result.insertions).toBe(3);
    expect(result.deletions).toBe(0);
  });

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
