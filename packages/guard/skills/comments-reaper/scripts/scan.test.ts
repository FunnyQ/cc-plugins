import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARD_BLOCKS, WAVE_SHARDS, scan, writeDeck } from "./scan.ts";

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
  git("config", "core.autocrlf", "false");
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

  test("a file and its test share a report, so parallel appliers never edit one test file", () => {
    for (let i = 0; i < SHARD_BLOCKS - 1; i++)
      put(`many/a${i}.ts`, "// c\nconst x = 1;\n");
    put("many/b.test.ts", "// c\n");
    put("many/b.ts", "// c\n");
    const out = scan(repo, ["many"]);
    const home = out.reports.find((r) => r.includes("many/b.ts:"));
    expect(home).toContain("many/b.test.ts:");
  });

  test("the CLI pairs every report with the verdicts file its reviewer writes", () => {
    for (let i = 0; i < SHARD_BLOCKS + 1; i++)
      put(`many/f${i}.ts`, "// c\nconst x = 1;\n");
    const cli = join(import.meta.dir, "scan.ts");
    const out = Bun.spawnSync(["bun", cli, "many"], {
      cwd: repo,
      stdout: "pipe",
    })
      .stdout.toString()
      .split("\n")
      .filter((l) => l.startsWith("report "));
    expect(out).toHaveLength(2);
    for (const line of out)
      expect(line).toMatch(
        /^report (\S+)\/report-(\d)\.txt verdicts \1\/verdicts-\2\.txt$/,
      );
  });

  test("a file holding more blocks than SHARD_BLOCKS gets a report of its own", () => {
    put("big.ts", "// c\nconst x = 1;\n".repeat(SHARD_BLOCKS + 1));
    put("small.ts", "// c\n");
    const out = scan(repo, ["big.ts", "small.ts"]);
    expect(out.reports).toHaveLength(2);
  });

  test("past WAVE_SHARDS reports the CLI schedules waves instead of refusing", () => {
    for (let i = 0; i < SHARD_BLOCKS * WAVE_SHARDS + 1; i++)
      put(`many/f${i}.ts`, "// c\nconst x = 1;\n");
    const cli = join(import.meta.dir, "scan.ts");
    const run = Bun.spawnSync(["bun", cli, "many"], {
      cwd: repo,
      stdout: "pipe",
    });
    expect(run.exitCode).toBe(0);
    const lines = run.stdout.toString().split("\n");
    const waves: number[] = [];
    for (const line of lines) {
      if (line.startsWith("wave ")) waves.push(0);
      else if (line.startsWith("report ")) waves[waves.length - 1]++;
    }
    expect(waves).toEqual([WAVE_SHARDS, 1]);
    expect(lines).toContain("wave 1 of 2");
  });
});

describe("writeDeck", () => {
  test("declares one flightdeck node per shard, with a run id, under the XDG data home", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "reaper-deck-")));
    const dir = writeDeck(home, repo, "scan-abc123", 3);
    expect(dir).toBe(
      join(home, "q-lab", "flightdeck", "comments-reaper-scan-abc123"),
    );
    const graph = JSON.parse(readFileSync(join(dir!, "graph.json"), "utf8"));
    expect(graph.version).toBe(1);
    expect(graph.repoRoot).toBe(repo);
    expect(graph.lanes).toEqual(["shards"]);
    expect(graph.nodes.map((n: { ref: string }) => n.ref)).toEqual([
      "shard/01",
      "shard/02",
      "shard/03",
    ]);
    expect(readFileSync(join(dir!, "run.id"), "utf8").trim()).toBe(
      "scan-abc123",
    );
  });

  test("--workflow prints the shard count and the deck instead of one line per report", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "reaper-deck-")));
    const cli = join(import.meta.dir, "scan.ts");
    const lines = Bun.spawnSync(["bun", cli, "--workflow", "src"], {
      cwd: repo,
      stdout: "pipe",
      env: { ...process.env, XDG_DATA_HOME: home },
    })
      .stdout.toString()
      .trim()
      .split("\n");
    expect(lines[1]).toMatch(/^shards 1 in \/\S+\/scan-\w+$/);
    expect(lines[2]).toStartWith(
      `deck ${join(home, "q-lab", "flightdeck", "comments-reaper-scan-")}`,
    );
    expect(lines.some((l) => l.startsWith("report "))).toBe(false);
  });

  test("past 99 shards writes no deck, since a flightdeck ref holds two digits", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "reaper-deck-")));
    expect(writeDeck(home, repo, "scan-big", 100)).toBeNull();
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
