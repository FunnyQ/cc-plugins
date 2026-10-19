import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILES, scan } from "./scan.ts";

let repo: string;

const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe" });
const put = (file: string, text: string) => {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), text);
};

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "reaper-repo-")));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  put("src/a.ts", "// header\nconst a = 1;\n// lone\nconst b = 2;\n");
  put("src/b.ts", "const c = 3;\n");
  put("lib/c.rb", "x = 1\n# ruby\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterEach(async () => {
  await Bun.$`rm -rf ${repo}`.quiet();
});

describe("scan with paths", () => {
  test("a directory reports every comment under it, one-liners and the header included", () => {
    const out = scan(repo, ["src"]);
    expect(out.files).toBe(1);
    expect(out.report).toContain("+ 1  // header");
    expect(out.report).toContain("+ 3  // lone");
    expect(out.report).not.toContain("ruby");
  });

  test("a single file reports only that file", () => {
    const out = scan(repo, ["lib/c.rb"]);
    expect(out.report).toContain("lib/c.rb:2");
    expect(out.report).not.toContain("src/a.ts");
  });

  test("a path resolves from the cwd, and the report names files from the root", () => {
    const out = scan(join(repo, "src"), ["a.ts"]);
    expect(out.report).toContain("src/a.ts:1");
  });

  test("a path that matches nothing reports nothing", () => {
    expect(scan(repo, ["nope"]).files).toBe(0);
  });

  test("too many files refuses instead of reporting", () => {
    for (let i = 0; i <= MAX_FILES; i++) put(`many/f${i}.ts`, "// c\n");
    const out = scan(repo, ["many"]);
    expect(out.report).toBe("");
    expect(out.refused).toContain(`${MAX_FILES + 1} files`);
  });
});

describe("scan with no paths", () => {
  test("reports only the comment lines changed since HEAD, with their whole block", () => {
    put(
      "src/a.ts",
      "// header\nconst a = 1;\n// lone\n// fresh\nconst b = 2;\n",
    );
    const out = scan(repo, []);
    expect(out.files).toBe(1);
    expect(out.report).toContain("    3  // lone");
    expect(out.report).toContain("+ 4  // fresh");
    expect(out.report).not.toContain("header");
  });

  test("an untracked file counts in full", () => {
    put("src/new.ts", "// brand new\nconst d = 4;\n");
    expect(scan(repo, []).report).toContain("+ 1  // brand new");
  });

  test("a clean tree reports nothing", () => {
    expect(scan(repo, []).files).toBe(0);
  });
});
