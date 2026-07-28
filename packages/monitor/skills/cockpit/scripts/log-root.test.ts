import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gitRootOf, logRoot, resolveKnownProject } from "./log-root";

const temps: string[] = [];

function tempDir(prefix = "cockpit-logroot-"): string {
  // realpath: on macOS tmpdir() is a symlink (/tmp -> /private/tmp) and
  // `git rev-parse --show-toplevel` resolves it, so the fixtures must too.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function mkdirp(...segments: string[]): string {
  const dir = join(...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A logRoot() whose git resolution is stubbed — isolates the walk-up rules. */
function withGitRoot(root: string | null) {
  return (cwd: string) => logRoot(cwd, { gitRoot: () => root });
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("logRoot", () => {
  test("returns the git root for a subpackage with no .cockpit of its own", () => {
    const repo = tempDir();
    const frontend = mkdirp(repo, "frontend");

    expect(withGitRoot(repo)(frontend)).toBe(repo);
  });

  test("returns the git root when cwd is already the git root", () => {
    const repo = tempDir();

    expect(withGitRoot(repo)(repo)).toBe(repo);
  });

  test("prefers an existing .cockpit in the subpackage (escape hatch)", () => {
    const repo = tempDir();
    const frontend = mkdirp(repo, "frontend");
    mkdirp(frontend, ".cockpit");

    expect(withGitRoot(repo)(frontend)).toBe(frontend);
  });

  test("picks the nearest existing .cockpit between cwd and the git root", () => {
    const repo = tempDir();
    const frontend = mkdirp(repo, "frontend");
    const nested = mkdirp(frontend, "src", "components");
    mkdirp(repo, ".cockpit");
    mkdirp(frontend, ".cockpit");

    expect(withGitRoot(repo)(nested)).toBe(frontend);
  });

  test("never walks above the git root — an ancestor .cockpit cannot capture the repo", () => {
    // The real footgun: ~/.cockpit is a leftover of the pre-XDG cockpit home and
    // still exists on machines that migrated, so every repo under $HOME would
    // otherwise resolve to $HOME.
    const home = tempDir();
    mkdirp(home, ".cockpit");
    const repo = mkdirp(home, "Projects", "app");
    const frontend = mkdirp(repo, "frontend");

    expect(withGitRoot(repo)(frontend)).toBe(repo);
    expect(withGitRoot(repo)(repo)).toBe(repo);
  });

  test("outside a git repo, uses cwd and does not walk up", () => {
    const parent = tempDir();
    mkdirp(parent, ".cockpit");
    const loose = mkdirp(parent, "loose");

    expect(withGitRoot(null)(loose)).toBe(loose);
  });

  test("outside a git repo, still honors cwd's own .cockpit", () => {
    const loose = tempDir();
    mkdirp(loose, ".cockpit");

    expect(withGitRoot(null)(loose)).toBe(loose);
  });

  test("ignores a .cockpit FILE — only a directory anchors the trail", () => {
    const repo = tempDir();
    const frontend = mkdirp(repo, "frontend");
    writeFileSync(join(frontend, ".cockpit"), "not a dir");

    expect(withGitRoot(repo)(frontend)).toBe(repo);
  });

  test("normalizes a cwd containing .. before comparing to the git root", () => {
    const repo = tempDir();
    const frontend = mkdirp(repo, "frontend");

    expect(withGitRoot(repo)(join(frontend, "..", "frontend"))).toBe(repo);
  });

  test("resolves a symlinked cwd so it compares against the git root", () => {
    const repo = tempDir();
    const frontend = mkdirp(repo, "frontend");
    const link = join(tempDir(), "link-to-frontend");
    symlinkSync(frontend, link);

    // git reports the realpath toplevel, so an unresolved cwd would never match.
    expect(withGitRoot(repo)(link)).toBe(repo);
  });

  test("falls back to the git root when cwd sits outside it", () => {
    // Defensive: if the reported root is not an ancestor of cwd, the walk-up
    // must not wander up cwd's own branch and adopt a .cockpit above the root.
    const base = tempDir();
    const outside = mkdirp(base, "above", "outside");
    mkdirp(base, "above", ".cockpit");
    const repo = mkdirp(base, "reported", "repo");

    expect(withGitRoot(repo)(outside)).toBe(repo);
  });
});

describe("resolveKnownProject", () => {
  const known = ["/repo", "/repo/frontend", "/other"];

  test("passes an exact match through", () => {
    expect(resolveKnownProject("/repo", known)).toBe("/repo");
  });

  test("maps a subdirectory onto its registered root", () => {
    // The deep-link case: usage-dashboard sends the live session's raw cwd.
    expect(resolveKnownProject("/repo/backend/src", known)).toBe("/repo");
  });

  test("prefers the nearest registered root", () => {
    expect(resolveKnownProject("/repo/frontend/src", known)).toBe(
      "/repo/frontend",
    );
  });

  test("does not match a sibling sharing a name prefix", () => {
    expect(resolveKnownProject("/repo-other/src", known)).toBeNull();
  });

  test("returns null for an unknown project", () => {
    expect(resolveKnownProject("/elsewhere", known)).toBeNull();
    expect(resolveKnownProject("", known)).toBeNull();
  });

  test("never resolves a parent of a known project", () => {
    expect(resolveKnownProject("/", known)).toBeNull();
  });
});

describe("gitRootOf", () => {
  test("finds the top level from a subdirectory of a real repo", () => {
    const repo = tempDir();
    spawnSync("git", ["init", "-q", repo]);
    const nested = mkdirp(repo, "packages", "api");

    expect(gitRootOf(nested)).toBe(repo);
  });

  test("returns null outside a repo", () => {
    // A bare temp dir under /tmp is not inside any repo.
    expect(gitRootOf(tempDir())).toBeNull();
  });

  test("a linked worktree resolves to the worktree, not the main checkout", () => {
    const repo = tempDir();
    spawnSync("git", ["init", "-q", "-b", "main", repo]);
    spawnSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "x"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    const wt = join(tempDir(), "wt");
    spawnSync("git", ["-C", repo, "worktree", "add", "-q", wt, "-b", "side"]);

    expect(gitRootOf(wt)).toBe(realpathSync(wt));
  });
});
