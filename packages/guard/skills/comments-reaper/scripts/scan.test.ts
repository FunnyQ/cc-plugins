import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BLOCKS, SHARD_BLOCKS, scan } from "./scan.ts";

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
    expect(out.reports[0]).toContain("+ 1  // header");
    expect(out.reports[0]).toContain("+ 3  // lone");
    expect(out.reports[0]).not.toContain("ruby");
  });

  test("a single file reports only that file", () => {
    const out = scan(repo, ["lib/c.rb"]);
    expect(out.reports[0]).toContain("lib/c.rb:2");
    expect(out.reports[0]).not.toContain("src/a.ts");
  });

  test("a path resolves from the cwd, and the report names files from the root", () => {
    const out = scan(join(repo, "src"), ["a.ts"]);
    expect(out.reports[0]).toContain("src/a.ts:1");
  });

  test("a path that matches nothing reports nothing", () => {
    expect(scan(repo, ["nope"]).files).toBe(0);
  });

  test("a small scope fits one report", () => {
    expect(scan(repo, ["src", "lib"]).reports).toHaveLength(1);
  });

  test("a wide scope splits into reports of at most SHARD_BLOCKS blocks, never splitting a file", () => {
    for (let i = 0; i < SHARD_BLOCKS + 5; i++)
      put(`many/f${i}.ts`, "// c\nconst x = 1;\n");
    const out = scan(repo, ["many"]);
    expect(out.reports).toHaveLength(2);
    const counts = out.reports.map((r) => r.match(/^\s+\+ /gm)?.length ?? 0);
    expect(counts).toEqual([SHARD_BLOCKS, 5]);
  });

  test("a file holding more blocks than SHARD_BLOCKS gets a report of its own", () => {
    put("big.ts", "// c\nconst x = 1;\n".repeat(SHARD_BLOCKS + 1));
    put("small.ts", "// c\n");
    const out = scan(repo, ["big.ts", "small.ts"]);
    expect(out.reports).toHaveLength(2);
  });

  test("past MAX_BLOCKS refuses instead of reporting", () => {
    put("huge.ts", "// c\nconst x = 1;\n".repeat(MAX_BLOCKS + 1));
    const out = scan(repo, ["huge.ts"]);
    expect(out.reports).toEqual([]);
    expect(out.refused).toContain(`${MAX_BLOCKS + 1} comment blocks`);
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
    expect(out.reports[0]).toContain("    3  // lone");
    expect(out.reports[0]).toContain("+ 4  // fresh");
    expect(out.reports[0]).not.toContain("header");
  });

  test("an untracked file counts in full", () => {
    put("src/new.ts", "// brand new\nconst d = 4;\n");
    expect(scan(repo, []).reports.join("")).toContain("+ 1  // brand new");
  });

  test("a clean tree reports nothing", () => {
    expect(scan(repo, []).files).toBe(0);
  });
});
