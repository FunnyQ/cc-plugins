import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_MS } from "../../../shared/scripts/cockpit-trail";
import {
  archiveIgnored,
  archiveTrail,
  findTrailRoots,
  formatTrail,
} from "./archive-stale";

const script = join(import.meta.dir, "archive-stale.ts");
const destination = ".cockpit/archive/done/old.jsonl";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archive-stale-")));
  roots.push(root);
  return root;
}

function trail(root: string, ...segments: string[]): string {
  const directory = join(root, ...segments);
  mkdirSync(join(directory, ".cockpit", "logs"), { recursive: true });
  return directory;
}

function session(
  trailRoot: string,
  sessionId: string,
  ageMs = STALE_MS + 1_000,
  bucket: "logs" | "archive/watch" = "logs",
): string {
  const directory = join(trailRoot, ".cockpit", bucket);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${sessionId}.jsonl`);
  writeFileSync(path, "{}\n");
  const date = new Date(Date.now() - ageMs);
  utimesSync(path, date, date);
  return path;
}

function gitRepository(root: string, gitignore: string): void {
  spawnSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), gitignore);
}

describe("findTrailRoots", () => {
  test("finds nested trails and prunes excluded directories", () => {
    const scan = temporaryRoot();
    const app = trail(scan, "app");
    const nested = trail(scan, "app", "packages", "lib");
    trail(scan, "app", "node_modules", "dep");
    trail(scan, ".stversions", "app~20260910");
    trail(scan, ".Trash", "old");
    trail(scan, "plugin", "skills", "adr", "references", "fixtures", "case");
    mkdirSync(join(scan, "meta-only", ".cockpit"), { recursive: true });

    expect(findTrailRoots([{ dir: scan, deep: true }])).toEqual([app, nested]);
  });

  test("a shallow scan root checks only itself", () => {
    const home = trail(temporaryRoot());
    trail(home, "deeper");

    expect(findTrailRoots([{ dir: home, deep: false }])).toEqual([home]);
  });

  test("skips a missing scan root and never follows a symlink", () => {
    const scan = temporaryRoot();
    const elsewhere = temporaryRoot();
    trail(elsewhere, "linked");
    symlinkSync(elsewhere, join(scan, "link"));

    expect(
      findTrailRoots([
        { dir: join(scan, "missing"), deep: true },
        { dir: scan, deep: true },
      ]),
    ).toEqual([]);
  });

  test("reports a trail reached from two scan roots once", () => {
    const scan = temporaryRoot();
    const app = trail(scan, "app");

    expect(
      findTrailRoots([
        { dir: scan, deep: true },
        { dir: app, deep: false },
      ]),
    ).toEqual([app]);
  });
});

describe("archiveTrail", () => {
  test("moves stale inbox logs to done and leaves fresh and watched logs", async () => {
    const root = trail(temporaryRoot());
    const old = session(root, "old");
    const fresh = session(root, "fresh", 1_000);
    const watched = session(root, "watched", STALE_MS + 1_000, "archive/watch");

    const result = await archiveTrail(root, { apply: true });

    expect(result.moves.map(({ from }) => from)).toEqual([old]);
    expect(result.skipped.map(({ reason }) => reason)).toEqual(["live"]);
    expect(
      existsSync(join(root, ".cockpit", "archive", "done", "old.jsonl")),
    ).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(watched)).toBe(true);
  });

  test("a dry run plans the moves without touching the trail", async () => {
    const root = trail(temporaryRoot());
    const old = session(root, "old");

    const result = await archiveTrail(root, { apply: false });

    expect(result.moves).toHaveLength(1);
    expect(existsSync(old)).toBe(true);
    expect(existsSync(join(root, ".cockpit", "archive"))).toBe(false);
  });
});

describe("archiveIgnored", () => {
  test("is null outside a git repository", () => {
    expect(archiveIgnored(trail(temporaryRoot()), [destination])).toBeNull();
  });

  test("is false when only the inbox is ignored", () => {
    const root = trail(temporaryRoot());
    gitRepository(root, ".cockpit/logs/\n");
    expect(archiveIgnored(root, [destination])).toBe(false);
  });

  for (const pattern of [".cockpit/archive/", ".cockpit/"]) {
    test(`is true when ${pattern} is ignored`, () => {
      const root = trail(temporaryRoot());
      gitRepository(root, `${pattern}\n`);
      expect(archiveIgnored(root, [destination])).toBe(true);
    });
  }

  test("reads the repository's ignore rules from a nested trail", () => {
    const repository = temporaryRoot();
    gitRepository(repository, ".cockpit/logs/\n");
    expect(
      archiveIgnored(trail(repository, "packages", "lib"), [destination]),
    ).toBe(false);
  });

  test("is false when a negation re-includes one destination", () => {
    const root = trail(temporaryRoot());
    gitRepository(
      root,
      ".cockpit/archive/done/*.jsonl\n!.cockpit/archive/done/exposed.jsonl\n",
    );
    const exposed = ".cockpit/archive/done/exposed.jsonl";

    expect(archiveIgnored(root, [destination])).toBe(true);
    expect(archiveIgnored(root, [destination, exposed])).toBe(false);
  });
});

describe("formatTrail", () => {
  test("warns only when archived logs could be committed", () => {
    const base = {
      trailRoot: "/repo",
      moves: [],
      skipped: [],
    };

    expect(
      formatTrail({ ...base, archiveIgnored: false }, true).join("\n"),
    ).toContain(".cockpit/archive/");
    expect(formatTrail({ ...base, archiveIgnored: true }, true)).toHaveLength(
      1,
    );
    expect(formatTrail({ ...base, archiveIgnored: null }, true)).toHaveLength(
      1,
    );
  });
});

describe("CLI", () => {
  test("exits non-zero when cwd holds no trail", () => {
    const run = spawnSync(process.execPath, [script, "--apply"], {
      cwd: temporaryRoot(),
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("No trail");
  });

  test("rejects an unknown flag", () => {
    const run = spawnSync(process.execPath, [script, "--root", "/tmp"], {
      cwd: trail(temporaryRoot()),
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
  });

  test("archives the cwd trail and prints a summary", () => {
    const root = trail(temporaryRoot());
    session(root, "old");

    const run = spawnSync(process.execPath, [script, "--apply"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("moved 1");
    expect(
      existsSync(join(root, ".cockpit", "archive", "done", "old.jsonl")),
    ).toBe(true);
  });
});
