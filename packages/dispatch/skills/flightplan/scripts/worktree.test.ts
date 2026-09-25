import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create, fingerprint, land, rebase, remove, show, sweep, unland } from "./worktree";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe", stderr: "pipe", env: process.env,
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
}

function put(root: string, path: string, content: string | Uint8Array) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function fixture() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-worktree-test-")));
  scratch.push(temp);
  const repo = join(temp, "parent", "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Worktree Test");
  git(repo, "config", "user.email", "worktree@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  put(repo, "a.txt", "base\n");
  put(repo, "b.txt", "second\n");
  put(repo, ".gitignore", "node_modules/\n.flightlog/\n");
  put(repo, "docs/test-plan/PLAN.md", "plan\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "fixture");
  return { repo, slug: "test-plan", ref: "work-tree/01" };
}

function rootOf(options: { repo: string; slug: string }) {
  return join(dirname(options.repo), ".repo-autopilot", options.slug);
}

function state(options: { repo: string; slug: string }) {
  return JSON.parse(readFileSync(join(rootOf(options), "state.json"), "utf8"));
}

function cli(args: string[]) {
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "worktree.ts"), ...args], {
    stdout: "pipe", stderr: "pipe", env: process.env,
  });
}

describe("worktree lifecycle", () => {
  test("snapshots rehash racy files when the copied index has matching timestamps", () => {
    const options = fixture();
    git(options.repo, "config", "core.trustctime", "false");
    const file = join(options.repo, "a.txt");
    const index = join(options.repo, ".git/index");
    const timestamp = new Date(Date.now() - 10_000);
    utimesSync(file, timestamp, timestamp);
    git(options.repo, "add", "a.txt");
    put(options.repo, "a.txt", "main\n");
    utimesSync(file, timestamp, timestamp);
    utimesSync(index, timestamp, timestamp);
    const before = readFileSync(index);
    const wt = create(options);
    expect(readFileSync(join(wt.path, "a.txt"), "utf8")).toBe("main\n");
    expect(readFileSync(index)).toEqual(before);
    expect(statSync(index).mtimeMs).toBe(timestamp.getTime());
  });

  test("create snapshots tracked and untracked files, seeds ignored paths, and excludes the plan", () => {
    const options = fixture();
    put(options.repo, "a.txt", "dirty tracked\n");
    put(options.repo, "new.txt", "untracked\n");
    put(options.repo, "node_modules/x/index.js", "dependency\n");
    put(options.repo, "packages/x/node_modules/y/index.js", "nested\n");
    put(options.repo, "docs/test-plan/.flightlog/log", "ignored\n");
    const result = create(options);
    expect(result).toEqual({ path: join(rootOf(options), "work-tree-01"), base: expect.any(String) });
    expect(readFileSync(join(result.path, "a.txt"), "utf8")).toBe("dirty tracked\n");
    expect(readFileSync(join(result.path, "new.txt"), "utf8")).toBe("untracked\n");
    expect(readFileSync(join(result.path, "node_modules/x/index.js"), "utf8")).toBe("dependency\n");
    expect(readFileSync(join(result.path, "packages/x/node_modules/y/index.js"), "utf8")).toBe("nested\n");
    expect(existsSync(join(result.path, "docs/test-plan"))).toBe(false);
    expect(git(result.path, "rev-parse", "HEAD")).toBe(result.base);
    expect(show(options)).toEqual({ ...result, exists: true });
  });

  test("clean land and unland preserve the real index and replay operations before checking leaks", () => {
    const options = fixture();
    const index = join(options.repo, ".git/index");
    const before = readFileSync(index);
    const wt = create(options);
    expect(readFileSync(index)).toEqual(before);
    const baseline = fingerprint(options).fingerprint;
    put(wt.path, "a.txt", "landed\n");
    const request = { ...options, expect: baseline, op: "a1-land" };
    const result = land(request);
    expect(result).toEqual({ status: "clean", drift: false, files: ["a.txt"], paths: [], previous: baseline, fingerprint: fingerprint(options).fingerprint });
    expect(readFileSync(join(options.repo, "a.txt"), "utf8")).toBe("landed\n");
    expect(readFileSync(index)).toEqual(before);
    const savedState = readFileSync(join(rootOf(options), "state.json"));
    expect(land(request)).toEqual(result);
    expect(readFileSync(join(rootOf(options), "state.json"))).toEqual(savedState);
    expect(readFileSync(join(options.repo, "a.txt"), "utf8")).toBe("landed\n");
    put(options.repo, "b.txt", "unrelated later edit\n");
    const undo = unland({ ...options, op: "a1-unland" });
    expect(undo).toEqual({ restored: ["a.txt"] });
    expect(readFileSync(join(options.repo, "a.txt"), "utf8")).toBe("base\n");
    expect(readFileSync(join(options.repo, "b.txt"), "utf8")).toBe("unrelated later edit\n");
    expect(unland({ ...options, op: "a1-unland" })).toEqual(undo);
    expect(state(options)[options.ref].previous).toBeUndefined();
    expect(state(options)[options.ref].landed).toBeUndefined();
    const rebased = rebase({ ...options, op: "a1-rebase" });
    expect(rebased.conflicted).toEqual([]);
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(rebased.base);
    expect(readFileSync(join(wt.path, "a.txt"), "utf8")).toBe("landed\n");
    expect(readFileSync(index)).toEqual(before);
    expect(git(options.repo, "diff", "--cached", "--name-only")).toBe("");
  });

  test("drift merges independent main and worktree edits", () => {
    const options = fixture();
    const wt = create(options);
    put(wt.path, "a.txt", "task edit\n");
    put(options.repo, "b.txt", "main edit\n");
    const result = land({ ...options, expect: fingerprint(options).fingerprint, op: "a1-land" });
    expect(result.status).toBe("clean");
    expect(result.drift).toBe(true);
    expect(result.files).toEqual(["a.txt"]);
    expect(readFileSync(join(options.repo, "a.txt"), "utf8")).toBe("task edit\n");
    expect(readFileSync(join(options.repo, "b.txt"), "utf8")).toBe("main edit\n");
  });

  test("conflict preserves main and merge state; rebase checks out markers and pins HEAD", () => {
    const options = fixture();
    const wt = create(options);
    put(wt.path, "a.txt", "task edit\n");
    put(options.repo, "a.txt", "main edit\n");
    const baseline = fingerprint(options).fingerprint;
    const result = land({ ...options, expect: baseline, op: "a1-land" });
    expect(result).toEqual({ status: "conflict", drift: true, files: ["a.txt"], paths: [], fingerprint: baseline, previous: baseline });
    expect(readFileSync(join(options.repo, "a.txt"), "utf8")).toBe("main edit\n");
    expect(fingerprint(options).fingerprint).toBe(baseline);
    expect(state(options)[options.ref]).toEqual({ ...wt, ops: { "a1-land": result } });
    const rebased = rebase({ ...options, op: "a1-rebase" });
    expect(rebased).toEqual({ path: wt.path, base: expect.any(String), conflicted: ["a.txt"] });
    expect(readFileSync(join(wt.path, "a.txt"), "utf8")).toContain("<<<<<<<");
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(rebased.base);
    expect(git(options.repo, "rev-parse", `${rebased.base}^{tree}`)).toBe(baseline);
    put(wt.path, "a.txt", "resolved after rebase\n");
    expect(rebase({ ...options, op: "a1-rebase" })).toEqual(rebased);
    expect(readFileSync(join(wt.path, "a.txt"), "utf8")).toBe("resolved after rebase\n");
  });

  test("a new land op acts after conflict resolution with the same expectation", () => {
    const options = fixture();
    const wt = create(options);
    put(options.repo, "a.txt", "main\n");
    put(wt.path, "a.txt", "task\n");
    const request = { ...options, expect: fingerprint(options).fingerprint };
    const conflict = land({ ...request, op: "a1-land" });
    expect(conflict.status).toBe("conflict");
    put(wt.path, "a.txt", "main\n");
    put(wt.path, "fixed.txt", "fixed\n");
    expect(land({ ...request, op: "a1-land" })).toEqual(conflict);
    expect(land({ ...request, op: "a2-land" }).status).toBe("clean");
    expect(readFileSync(join(options.repo, "fixed.txt"), "utf8")).toBe("fixed\n");
  });

  test("leak reports actual differences, records the op, and leaves merge state untouched", () => {
    const options = fixture();
    const wt = create(options);
    const stale = fingerprint(options).fingerprint;
    put(options.repo, "b.txt", "leak\n");
    const actual = fingerprint({ ...options, expect: stale });
    const request = { ...options, expect: stale, op: "a1-land" };
    const result = land(request);
    expect(result).toEqual({ status: "leak", drift: false, files: [], paths: ["b.txt"], fingerprint: actual.fingerprint, previous: stale });
    expect(actual.paths).toEqual(result.paths);
    expect(state(options)[options.ref]).toEqual({ ...wt, ops: { "a1-land": result } });
    put(options.repo, "b.txt", "changed again\n");
    expect(land(request)).toEqual(result);
    expect(readFileSync(join(options.repo, "b.txt"), "utf8")).toBe("changed again\n");
  });

  test("plan updates do not change fingerprints or trigger leaks", () => {
    const options = fixture();
    create(options);
    const baseline = fingerprint(options).fingerprint;
    put(options.repo, "docs/test-plan/PLAN.md", "new status\n");
    put(options.repo, "docs/test-plan/tasks/new.md", "new task\n");
    expect(fingerprint({ ...options, expect: baseline })).toEqual({ fingerprint: baseline, paths: [] });
    expect(land({ ...options, expect: baseline, op: "empty-land" }).status).toBe("clean");
    expect(unland({ ...options, op: "empty-unland" })).toEqual({ restored: [] });
  });

  test("new rebase ops update the base each time", () => {
    const options = fixture();
    const wt = create(options);
    put(wt.path, "a.txt", "task\n");
    put(options.repo, "b.txt", "first\n");
    const first = rebase({ ...options, op: "a1-rebase" });
    put(options.repo, "b.txt", "second\n");
    const second = rebase({ ...options, op: "a2-rebase" });
    expect(first.base).not.toBe(second.base);
    expect(second.conflicted).toEqual([]);
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(second.base);
    expect(git(options.repo, "rev-parse", `${second.base}^{tree}`)).toBe(fingerprint(options).fingerprint);
    expect(readFileSync(join(wt.path, "b.txt"), "utf8")).toBe("second\n");
    expect(readFileSync(join(wt.path, "a.txt"), "utf8")).toBe("task\n");
  });

  test("show is read-only for unknown and deleted worktrees", () => {
    const options = fixture();
    const missing = { path: join(rootOf(options), "work-tree-01"), base: null, exists: false };
    expect(show(options)).toEqual(missing);
    expect(existsSync(rootOf(options))).toBe(false);
    const response = cli(["show", options.ref, "--repo", options.repo, "--slug", options.slug]);
    expect(response.exitCode).toBe(0);
    expect(JSON.parse(response.stdout.toString())).toEqual(missing);
    const wt = create(options);
    const before = readFileSync(join(rootOf(options), "state.json"));
    rmSync(wt.path, { recursive: true, force: true });
    expect(show(options)).toEqual({ ...wt, exists: false });
    expect(readFileSync(join(rootOf(options), "state.json"))).toEqual(before);
    expect(create(options).path).toBe(wt.path);
  });

  test("repeated create takes a fresh snapshot and clears cached ops", () => {
    const options = fixture();
    const first = create(options);
    land({ ...options, expect: fingerprint(options).fingerprint, op: "a1-land" });
    put(options.repo, "a.txt", "fresh\n");
    const second = create(options);
    expect(second.path).toBe(first.path);
    expect(readFileSync(join(second.path, "a.txt"), "utf8")).toBe("fresh\n");
    expect(state(options)[options.ref]).toEqual(second);
    expect(git(options.repo, "worktree", "list", "--porcelain").split("worktree ").length - 1).toBe(2);
  });

  test("sweep keep-all leaves state and registrations untouched; keep scopes removals to this slug", () => {
    const options = fixture();
    const first = create(options);
    const second = create({ ...options, ref: "work-tree/02" });
    const before = readFileSync(join(rootOf(options), "state.json"));
    const registrations = git(options.repo, "worktree", "list", "--porcelain");
    expect(sweep({ ...options, keepAll: true })).toEqual({ removed: [], kept: [{ ref: options.ref, path: first.path }, { ref: "work-tree/02", path: second.path }] });
    expect(readFileSync(join(rootOf(options), "state.json"))).toEqual(before);
    expect(git(options.repo, "worktree", "list", "--porcelain")).toBe(registrations);
    create({ ...options, ref: "work-tree/03" });
    const other = create({ ...options, slug: "other-plan" });
    const userPath = join(dirname(options.repo), "user-worktree");
    git(options.repo, "worktree", "add", "--detach", userPath, "HEAD");
    const result = sweep({ ...options, keep: ["work-tree/02"] });
    expect(result).toEqual({ removed: ["work-tree/01", "work-tree/03"], kept: [{ ref: "work-tree/02", path: second.path }] });
    expect(existsSync(other.path)).toBe(true);
    expect(existsSync(userPath)).toBe(true);
    const remaining = git(options.repo, "worktree", "list", "--porcelain");
    expect(remaining).toContain(second.path);
    expect(remaining).not.toContain(first.path);
    expect(remaining.split("worktree ").length - 1).toBe(4);
    for (const removed of [true, false]) {
      const response = cli(["remove", "work-tree/02", "--repo", options.repo, "--slug", options.slug]);
      expect(response.exitCode).toBe(0);
      expect(JSON.parse(response.stdout.toString())).toEqual({ removed });
    }
    expect(sweep(options)).toEqual({ removed: [], kept: [] });
    expect(existsSync(rootOf(options))).toBe(false);
  });

  test("sweep removes previous run leftovers without state and clears deleted entries", () => {
    const options = fixture();
    const wt = create(options);
    const leftover = join(rootOf(options), "old-bucket-02");
    git(options.repo, "worktree", "add", "--detach", leftover, "HEAD");
    rmSync(wt.path, { recursive: true, force: true });
    expect(sweep(options)).toEqual({ removed: ["old-bucket/02", options.ref], kept: [] });
    expect(existsSync(rootOf(options))).toBe(false);
    expect(git(options.repo, "worktree", "list", "--porcelain").split("worktree ").length - 1).toBe(1);
  });

  test("binary, added, deleted and oddly named paths land and restore", () => {
    const options = fixture();
    const wt = create(options);
    const oddName = "space and\nnewline.txt";
    put(wt.path, oddName, "odd\n");
    put(wt.path, "binary.dat", new Uint8Array([0, 255, 1, 128, 2]));
    put(wt.path, "bytes.txt", new Uint8Array([255, 254, 10]));
    rmSync(join(wt.path, "a.txt"));
    const result = land({ ...options, expect: fingerprint(options).fingerprint, op: "binary-land" });
    expect(result.files).toEqual(["a.txt", "binary.dat", "bytes.txt", oddName]);
    expect(readFileSync(join(options.repo, "binary.dat"))).toEqual(Buffer.from([0, 255, 1, 128, 2]));
    expect(readFileSync(join(options.repo, "bytes.txt"))).toEqual(Buffer.from([255, 254, 10]));
    expect(existsSync(join(options.repo, "a.txt"))).toBe(false);
    expect(unland({ ...options, op: "binary-unland" })).toEqual({ restored: result.files });
    expect(readFileSync(join(options.repo, "a.txt"), "utf8")).toBe("base\n");
    expect(existsSync(join(options.repo, oddName))).toBe(false);
  });

  test("snapshots preserve an already staged real index byte for byte", () => {
    const options = fixture();
    put(options.repo, "a.txt", "staged\n");
    git(options.repo, "add", "a.txt");
    put(options.repo, "a.txt", "unstaged\n");
    const index = join(options.repo, ".git/index");
    const before = readFileSync(index);
    const wt = create(options);
    put(wt.path, "a.txt", "task\n");
    land({ ...options, expect: fingerprint(options).fingerprint, op: "a1-land" });
    unland({ ...options, op: "a1-unland" });
    rebase({ ...options, op: "a1-rebase" });
    expect(readFileSync(index)).toEqual(before);
    expect(git(options.repo, "show", ":a.txt")).toBe("staged");
  });

  test("ignored seeds fall back from clone copies and tolerate complete copy failure", () => {
    const options = fixture();
    put(options.repo, "node_modules/x/index.js", "dependency\n");
    const bin = join(dirname(options.repo), "bin");
    put(bin, "cp", '#!/bin/sh\nif [ "$1" = "-c" ]; then exit 1; fi\nexec /bin/cp "$@"\n');
    chmodSync(join(bin, "cp"), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      const first = create(options);
      expect(readFileSync(join(first.path, "node_modules/x/index.js"), "utf8")).toBe("dependency\n");
      put(bin, "cp", "#!/bin/sh\nexit 1\n");
      const second = create(options);
      expect(show(options)).toEqual({ ...second, exists: true });
      expect(existsSync(join(second.path, "node_modules/x/index.js"))).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("ignored ancestor directories never seed the excluded plan", () => {
    const options = fixture();
    git(options.repo, "rm", "-r", "--cached", "docs");
    put(options.repo, ".gitignore", "docs/\n");
    put(options.repo, "docs/other/guide.md", "keep\n");
    const wt = create(options);
    expect(existsSync(join(wt.path, "docs/test-plan"))).toBe(false);
    expect(readFileSync(join(wt.path, "docs/other/guide.md"), "utf8")).toBe("keep\n");
  });

  test("a failed unland records no op and can be retried after the obstacle is fixed", () => {
    const options = fixture();
    const wt = create(options);
    put(wt.path, "a.txt", "task\n");
    land({ ...options, expect: fingerprint(options).fingerprint, op: "a1-land" });
    put(options.repo, "a.txt", "obstacle\n");
    const response = cli(["unland", options.ref, "--repo", options.repo, "--slug", options.slug, "--op", "a1-unland"]);
    expect(response.exitCode).toBe(1);
    expect(response.stdout.toString()).toBe("");
    expect(response.stderr.toString()).toContain("apply --binary");
    expect(response.stderr.toString()).toContain("patch does not apply");
    expect(state(options)[options.ref].ops["a1-unland"]).toBeUndefined();
    put(options.repo, "a.txt", "task\n");
    expect(unland({ ...options, op: "a1-unland" })).toEqual({ restored: ["a.txt"] });
  });
});

describe("CLI argument and git failures", () => {
  test("every subcommand prints one JSON object and clean, leak, and conflict all exit 0", () => {
    const options = fixture();
    const common = ["--repo", options.repo, "--slug", options.slug];
    function invoke(...args: string[]) {
      const result = cli([...args, ...common]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString().trim().split("\n")).toHaveLength(1);
      return JSON.parse(result.stdout.toString());
    }
    const wt = invoke("create", options.ref);
    expect(invoke("show", options.ref)).toEqual({ ...wt, exists: true });
    const baseline = invoke("fingerprint").fingerprint;
    put(wt.path, "a.txt", "task\n");
    const landed = invoke("land", options.ref, "--expect", baseline, "--op", "a1-land");
    expect(landed.status).toBe("clean");
    expect(invoke("land", options.ref, "--expect", baseline, "--op", "a1-land")).toEqual(landed);
    expect(invoke("unland", options.ref, "--op", "a1-unland")).toEqual({ restored: ["a.txt"] });
    expect(invoke("rebase", options.ref, "--op", "a1-rebase").conflicted).toEqual([]);
    put(options.repo, "a.txt", "main\n");
    expect(invoke("land", options.ref, "--expect", baseline, "--op", "a2-land").status).toBe("leak");
    const current = invoke("fingerprint", "--expect", baseline);
    expect(current.paths).toEqual(["a.txt"]);
    expect(invoke("land", options.ref, "--expect", current.fingerprint, "--op", "a3-land").status).toBe("conflict");
    expect(invoke("sweep", "--keep-all")).toEqual({ removed: [], kept: [{ ref: options.ref, path: wt.path }] });
    expect(invoke("sweep", "--keep", options.ref).kept).toHaveLength(1);
    expect(invoke("remove", options.ref)).toEqual({ removed: true });
    expect(invoke("remove", options.ref)).toEqual({ removed: false });
    expect(invoke("sweep")).toEqual({ removed: [], kept: [] });
  });

  test("bad arguments and missing targets exit 2", () => {
    const options = fixture();
    const common = ["--repo", options.repo, "--slug", options.slug];
    const cases = [
      ["create", options.ref, "--slug", options.slug],
      ["unknown", ...common],
      ["create", "../01", ...common],
      ["create", "bucket/1", ...common],
      ["create", "bucket/001", ...common],
      ["create", options.ref, "--repo", "relative", "--slug", options.slug],
      ["create", options.ref, "--repo", options.repo, "--slug", "../escape"],
      ["land", options.ref, ...common, "--expect", "HEAD"],
      ["unland", options.ref, ...common],
      ["rebase", options.ref, ...common],
      ["unland", options.ref, ...common, "--op", "a1-unland"],
      ["rebase", options.ref, ...common, "--op", "a1-rebase"],
      ["land", options.ref, ...common, "--op", "a1-land"],
      ["fingerprint", ...common, "--unknown"],
      ["sweep", ...common, "--keep", "bad-ref"],
      ["sweep", ...common, "--keep-all", "--keep", options.ref],
    ];
    for (const args of cases) {
      const response = cli(args);
      expect({ args, exitCode: response.exitCode }).toEqual({ args, exitCode: 2 });
      expect(response.stdout.toString()).toBe("");
      expect(response.stderr.toString().length).toBeGreaterThan(0);
    }
  });

  test("git failure exits 1 with its command and stderr", () => {
    const options = fixture();
    const response = cli(["fingerprint", "--repo", dirname(options.repo), "--slug", options.slug]);
    expect(response.exitCode).toBe(1);
    expect(response.stdout.toString()).toBe("");
    expect(response.stderr.toString()).toContain("git -C");
    expect(response.stderr.toString()).toContain("not a git repository");
  });
});
