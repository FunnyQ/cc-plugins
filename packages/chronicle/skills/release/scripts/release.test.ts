import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import type { ReleaseConfig } from "./analyze-release";
import {
  formatPlanDigest,
  formatRunDigest,
  plan as planRelease,
  run,
  type Plan,
} from "./release";
import type { Unit } from "./stages";

const unit: Unit = {
  component: "chronicle",
  targetVersion: "0.16.0",
  lastTag: "chronicle-v0.15.1",
  tagName: "chronicle-v0.16.0",
  headerLabel: "chronicle 0.16.0",
  pathScope: "packages/chronicle",
  versionFiles: [
    { path: "packages/chronicle/.claude-plugin/plugin.json", kind: "json" },
  ],
  artifacts: [],
};

const plan: Plan = {
  workflow: "github-flow",
  branch: "main",
  head: "b0fd788d8e3c7ac00a83c22f5b3ffafc86bfb992",
  releaseCommit: "b0fd788d8e3c7ac00a83c22f5b3ffafc86bfb992",
  changelogPath: "CHANGELOG.md",
  units: [unit],
  files: ["packages/chronicle/.claude-plugin/plugin.json", "CHANGELOG.md"],
  subject: "🔧 release: chronicle 0.16.0",
  stages: [
    { id: "bump", state: "pending" },
    { id: "entry", state: "done" },
    { id: "tag", state: "pending" },
  ],
};

describe("formatPlanDigest", () => {
  test("carries only what the caller acts on — target, stage states, annalist's inputs — since run re-derives the rest from the units", () => {
    const digest = formatPlanDigest(plan);

    expect(digest).toContain("chronicle 0.16.0 → chronicle-v0.16.0");
    expect(digest).toContain("on b0fd788 (main, github-flow)");
    expect(digest).toContain(
      'CHANGELOG.md · header "chronicle 0.16.0" · scope packages/chronicle · since chronicle-v0.15.1',
    );
    expect(digest).toContain("🔧 release: chronicle 0.16.0");
  });

  test("marks a done stage, so the caller skips the annalist without reading JSON", () => {
    expect(formatPlanDigest(plan)).toContain("stages     bump entry✓ tag");
  });

  test("gives a blocked stage, the one thing that stops a release, its own line with the reason", () => {
    const digest = formatPlanDigest({
      ...plan,
      stages: [
        { id: "bump", state: "pending" },
        {
          id: "tag",
          state: "blocked",
          note: "chronicle-v0.16.0 is on 1a2b3c4",
        },
      ],
    });

    expect(digest).toContain("BLOCKED    tag: chronicle-v0.16.0 is on 1a2b3c4");
  });

  test("names a whole-repo unit and its scope without a component", () => {
    const digest = formatPlanDigest({
      ...plan,
      units: [
        { ...unit, component: null, pathScope: null, headerLabel: "0.16.0" },
      ],
    });

    expect(digest).toContain("plan       repo 0.16.0 →");
    expect(digest).toContain("scope whole repo");
  });
});

describe("formatRunDigest", () => {
  test("reports what ran, the commit, and the tags", () => {
    const digest = formatRunDigest({
      executed: ["bump", "entry", "commit", "tag"],
      skipped: [],
      releaseCommit: "b0fd788d8e3c7ac00a83c22f5b3ffafc86bfb992",
      tags: ["chronicle-v0.16.0"],
      branch: "main",
      workflow: "github-flow",
      log: "",
    });

    expect(digest).toContain("executed   bump entry commit tag");
    expect(digest).toContain("skipped    —");
    expect(digest).toContain("commit     b0fd788 on main");
    expect(digest).toContain("tags       chronicle-v0.16.0");
  });

  test("says so when a resumed run executed nothing, so empty lists never read as a release", () => {
    const digest = formatRunDigest({
      executed: [],
      skipped: ["bump", "entry"],
      releaseCommit: "b0fd788d8e3c7ac00a83c22f5b3ffafc86bfb992",
      tags: [],
      branch: "main",
      workflow: "github-flow",
      log: "",
    });

    expect(digest).toContain("nothing — every stage already done");
    expect(digest).toContain("tags       —");
  });
});

const cwd = process.cwd();
const scratch: string[] = [];

afterEach(() => {
  process.chdir(cwd);
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "release-test-"));
  scratch.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  process.chdir(dir);
  return dir;
}

async function commitAll(dir: string, message: string): Promise<void> {
  await $`git add -A && git -c user.name=t -c user.email=t@t commit -qm ${message}`
    .cwd(dir)
    .quiet();
}

async function initRepo(files: Record<string, string>): Promise<string> {
  const dir = repo(files);
  await $`git init -q -b main`.cwd(dir).quiet();
  await $`git config commit.gpgsign false && git config tag.gpgsign false`
    .cwd(dir)
    .quiet();
  await commitAll(dir, "init");
  return dir;
}

const gitText = async (dir: string, args: string[]) =>
  (await $`git ${args}`.cwd(dir).quiet()).stdout.toString().trim();

const githubFlow: ReleaseConfig = {
  mode: "whole-repo",
  workflow: "github-flow",
  tag: "v{version}",
  changelog: "CHANGELOG.md",
  branches: { main: "main" },
  versionFiles: [{ path: "VERSION", kind: "text" }],
};

const choices = [{ component: null, targetVersion: "0.2.0", lastTag: null }];
const noPersist = { persistConfig: false };

describe("plan", () => {
  test("lands every tag on main's HEAD, never on the branch the run stands on", async () => {
    const dir = await initRepo({ VERSION: "0.1.0\n" });
    const main = await gitText(dir, ["rev-parse", "main"]);
    await $`git checkout -qb feat`.cwd(dir).quiet();
    writeFileSync(join(dir, "work.txt"), "work\n");
    await commitAll(dir, "work");

    const result = await planRelease(githubFlow, choices, noPersist);

    expect(result.releaseCommit).toBe(main);
    expect(result.head).not.toBe(main);
  });

  test("asks git for the origin remote at most once, though run re-plans after every stage", async () => {
    const dir = await initRepo({ VERSION: "0.1.0\n" });
    const realGit = (await $`which git`.quiet()).stdout.toString().trim();
    const log = join(dir, "..", `${dir.split("/").pop()}.git-calls`);
    scratch.push(log);
    const shim = join(dir, "..", `${dir.split("/").pop()}-bin`);
    scratch.push(shim);
    mkdirSync(shim);
    writeFileSync(
      join(shim, "git"),
      `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(shim, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try {
      await planRelease(githubFlow, choices, noPersist);
      await planRelease(githubFlow, choices, noPersist);
    } finally {
      process.env.PATH = path;
    }

    const calls = (await Bun.file(log).text()).split("\n");
    expect(calls.some((c) => c.startsWith("rev-parse"))).toBe(true);
    expect(
      calls.filter((c) => c.startsWith("remote get-url")).length,
    ).toBeLessThanOrEqual(1);
  });
});

describe("run", () => {
  const withTool = (build?: string): ReleaseConfig => ({
    ...githubFlow,
    artifacts: [{ path: "bin/tool", ...(build ? { build } : {}) }],
  });
  const tool = (version: string) => `#!/bin/sh\necho tool ${version}\n`;

  async function toolRepo(): Promise<string> {
    const dir = await initRepo({
      VERSION: "0.1.0\n",
      "bin/tool": tool("0.1.0"),
      "next/tool": tool("0.2.0"),
    });
    chmodSync(join(dir, "bin/tool"), 0o755);
    chmodSync(join(dir, "next/tool"), 0o755);
    return dir;
  }

  test("commits on the release branch even when the run stands on another one", async () => {
    const dir = await initRepo({ VERSION: "0.1.0\n" });
    await $`git checkout -qb feat`.cwd(dir).quiet();
    writeFileSync(join(dir, "VERSION"), "0.2.0\n");
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      "# Changelog\n\n## [0.2.0] - 2026-01-01\n",
    );

    const result = await run(githubFlow, choices, {
      ...noPersist,
      through: "commit",
    });

    expect(result.executed).toEqual(["commit"]);
    expect(await gitText(dir, ["log", "-1", "--format=%s", "main"])).toBe(
      "🔧 release: 0.2.0",
    );
  });

  test("stops on a stale artifact with no build configured, before a tag can bake in the mismatch", async () => {
    await toolRepo();
    await expect(
      run(withTool(), choices, { ...noPersist, through: "artifacts" }),
    ).rejects.toThrow(
      /bin\/tool: reports "tool 0.1.0", expected 0.2.0 — rebuild it, then re-run/,
    );
  });

  test("runs the configured build for a stale artifact", async () => {
    await toolRepo();
    const result = await run(withTool("cp next/tool bin/tool"), choices, {
      ...noPersist,
      through: "artifacts",
    });
    expect(result.executed).toEqual(["bump", "artifacts"]);
  });

  test("throws when a stage runs but the repo does not reflect it, which catches an empty commit or a no-op merge", async () => {
    await toolRepo();
    await expect(
      run(withTool("true"), choices, { ...noPersist, through: "artifacts" }),
    ).rejects.toThrow(/artifacts ran but the repo does not reflect it/);
  });

  test("refuses the entry stage without the annalist's draft, so a bumped tree never tags without a CHANGELOG entry", async () => {
    await initRepo({ VERSION: "0.1.0\n" });
    await expect(
      run(githubFlow, choices, { ...noPersist, through: "entry" }),
    ).rejects.toThrow(/the CHANGELOG entry is missing for 0.2.0/);
  });
});
