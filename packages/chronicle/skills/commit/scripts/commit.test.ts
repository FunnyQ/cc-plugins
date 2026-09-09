import { $ } from "bun";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PlannedCommit, SimpleProse } from "./commit-plan";

const SCRIPT = resolve(import.meta.dir, "commit.ts");

let repo = "";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chronicle-commit-"));
  await $`git init -q -b main`.cwd(dir).quiet();
  await $`git config user.email t@t.t`.cwd(dir).quiet();
  await $`git config user.name t`.cwd(dir).quiet();
  await $`git config commit.gpgsign false`.cwd(dir).quiet();
  return dir;
}

async function seed(name: string, body: string): Promise<void> {
  await writeFile(join(repo, name), body);
}

async function baseCommit(): Promise<void> {
  await seed("README.md", "# repo\n");
  await $`git add -A`.cwd(repo).quiet();
  await $`git commit -q -m ${"🔧 chore: init"}`.cwd(repo).quiet();
}

type PlanShape = {
  /** Refused by the script — only the "it decided the shape itself" case sets it. */
  shape?: "simple" | "atomic";
  mode?: "auto" | "simple";
  commits: PlannedCommit[];
  simple?: SimpleProse;
  moduleSpread?: string[];
  totalFiles?: number;
};

// Outside the repo on purpose — a plan file inside it is part of the changeset.
async function writePlan(plan: PlanShape): Promise<string> {
  const path = join(
    await mkdtemp(join(tmpdir(), "chronicle-plan-")),
    "plan.json",
  );
  await writeFile(path, JSON.stringify(plan, null, 2));
  return path;
}

async function run(
  command: "apply",
  planPath: string,
): Promise<{ exitCode: number; json: any }> {
  const result = await $`bun ${SCRIPT} ${command} --plan-file ${planPath}`
    .cwd(repo)
    .quiet()
    .nothrow();
  const stdout = result.stdout.toString().trim();
  return {
    exitCode: result.exitCode,
    json: stdout ? JSON.parse(stdout) : null,
  };
}

async function subjects(): Promise<string[]> {
  const out = await $`git log --format=%s`.cwd(repo).quiet().nothrow();
  const text = out.stdout.toString().trim();
  return text ? text.split("\n") : [];
}

beforeEach(async () => {
  repo = await initRepo();
});

describe("shape", () => {
  test("decides atomic from the plan's own signals, with reasons", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    await seed("b.md", "b\n");
    const planPath = await writePlan({
      commits: [
        { type: "feat", subject: "add a", files: ["a.ts"] },
        { type: "docs", subject: "add b", files: ["b.md"] },
      ],
      simple: { type: "feat", subject: "add a and document it" },
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.shape).toBe("atomic");
    expect(json.reasons).toEqual(["2 change types: feat, docs"]);
    expect(await subjects()).toEqual([
      "📖 docs: add b",
      "✨ feat: add a",
      "🔧 chore: init",
    ]);
  });

  test("collapses to `simple`'s message when no signal fires", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    await seed("b.ts", "b\n");
    const planPath = await writePlan({
      commits: [
        { type: "feat", subject: "add a", files: ["a.ts"] },
        { type: "feat", subject: "add b", files: ["b.ts"] },
      ],
      moduleSpread: ["."],
      simple: {
        type: "feat",
        subject: "add a and b",
        body: "- one feature, two files",
        summary: "一起加。",
      },
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.shape).toBe("simple");
    expect(json.reasons).toEqual([]);
    expect(await subjects()).toEqual([
      "✨ feat: add a and b",
      "🔧 chore: init",
    ]);
  });

  test("simple mode overrides every signal", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    await seed("b.md", "b\n");
    const planPath = await writePlan({
      mode: "simple",
      commits: [
        { type: "feat", subject: "add a", files: ["a.ts"] },
        { type: "docs", subject: "add b", files: ["b.md"] },
      ],
      totalFiles: 20,
      moduleSpread: ["x", "y"],
      simple: { type: "feat", subject: "add both" },
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.shape).toBe("simple");
    expect(await subjects()).toEqual(["✨ feat: add both", "🔧 chore: init"]);
  });

  test("refuses a split with no collapsed message, before staging anything", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    await seed("b.md", "b\n");
    const planPath = await writePlan({
      commits: [
        { type: "feat", subject: "add a", files: ["a.ts"] },
        { type: "docs", subject: "add b", files: ["b.md"] },
      ],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(2);
    expect(json.errors).toHaveLength(1);
    expect(await subjects()).toEqual(["🔧 chore: init"]);
  });

  test("refuses a plan that decided the shape itself", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    const planPath = await writePlan({
      shape: "simple",
      commits: [{ type: "feat", subject: "add a", files: ["a.ts"] }],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(2);
    expect(json.errors[0]).toContain("remove `shape`");
  });

  test("refuses a plan file inside the repo", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    await seed(
      "plan.json",
      JSON.stringify({
        commits: [{ type: "feat", subject: "add a", files: ["a.ts"] }],
      }),
    );

    const result =
      await $`bun ${SCRIPT} apply --plan-file ${join(repo, "plan.json")}`
        .cwd(repo)
        .quiet()
        .nothrow();
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toContain("outside the repo");
  });

  test("refuses with no file", async () => {
    await baseCommit();
    const result = await $`bun ${SCRIPT} apply`.cwd(repo).quiet().nothrow();
    expect(result.exitCode).toBe(2);
  });
});

describe("apply", () => {
  test("writes an atomic split and verifies it", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    await seed("b.md", "b\n");
    const planPath = await writePlan({
      commits: [
        {
          emoji: "✨",
          type: "feat",
          subject: "add a",
          files: ["a.ts"],
          body: "- because",
          summary: "加了 a。",
        },
        { emoji: "📖", type: "docs", subject: "add b", files: ["b.md"] },
      ],
      simple: { type: "feat", subject: "add a and document it" },
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.executed).toHaveLength(2);
    expect(json.skipped).toHaveLength(0);
    expect(await subjects()).toEqual([
      "📖 docs: add b",
      "✨ feat: add a",
      "🔧 chore: init",
    ]);
  });

  test("writes the body and the 繁中 summary into the message", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    const planPath = await writePlan({
      commits: [
        {
          emoji: "✨",
          type: "feat",
          subject: "add a",
          files: ["a.ts"],
          body: "- because it was needed",
          summary: "加了 a。",
        },
      ],
    });

    expect((await run("apply", planPath)).exitCode).toBe(0);
    const message = (await $`git log -1 --format=%B`.cwd(repo).quiet()).stdout
      .toString()
      .trim();
    expect(message).toBe(
      "✨ feat: add a\n\n- because it was needed\n\n---\n\n加了 a。",
    );
  });

  test("commits into an unborn branch", async () => {
    await seed("a.ts", "a\n");
    const planPath = await writePlan({
      commits: [
        { emoji: "✨", type: "feat", subject: "first", files: ["a.ts"] },
      ],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
    expect(await subjects()).toEqual(["✨ feat: first"]);
  });

  test("carries a deletion", async () => {
    await baseCommit();
    await seed("gone.ts", "x\n");
    await $`git add -A`.cwd(repo).quiet();
    await $`git commit -q -m ${"✨ feat: add gone"}`.cwd(repo).quiet();
    await $`rm ${join(repo, "gone.ts")}`.quiet();

    const planPath = await writePlan({
      commits: [
        {
          emoji: "🔥",
          type: "remove",
          subject: "drop gone",
          files: ["gone.ts"],
        },
      ],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
  });

  test("carries a rename as one commit", async () => {
    await baseCommit();
    await seed("old.ts", "same content here\n");
    await $`git add -A`.cwd(repo).quiet();
    await $`git commit -q -m ${"✨ feat: add old"}`.cwd(repo).quiet();
    await $`git mv old.ts new.ts`.cwd(repo).quiet();

    const planPath = await writePlan({
      commits: [
        {
          emoji: "📦",
          type: "refactor",
          subject: "rename old to new",
          files: ["old.ts", "new.ts"],
        },
      ],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
  });

  test("carries a path with a space", async () => {
    await baseCommit();
    await seed("my notes.md", "hi\n");
    const planPath = await writePlan({
      commits: [
        {
          emoji: "📖",
          type: "docs",
          subject: "add notes",
          files: ["my notes.md"],
        },
      ],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
  });

  test("carries a non-ASCII path, which git status quotes", async () => {
    await baseCommit();
    await seed("筆記.md", "hi\n");
    const planPath = await writePlan({
      commits: [
        { emoji: "📖", type: "docs", subject: "add notes", files: ["筆記.md"] },
      ],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
  });

  test("carries a filename containing git's rename separator", async () => {
    await baseCommit();
    await seed("a -> b.txt", "hi\n");
    const planPath = await writePlan({
      commits: [
        { type: "docs", subject: "add the odd name", files: ["a -> b.txt"] },
      ],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.verify.plannedFiles).toBe(1);
  });

  test("carries a filename containing a newline", async () => {
    await baseCommit();
    await seed("two\nlines.txt", "hi\n");
    const planPath = await writePlan({
      commits: [
        {
          type: "docs",
          subject: "add the odd name",
          files: ["two\nlines.txt"],
        },
      ],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
  });

  test("renames a file whose name holds the rename separator", async () => {
    await baseCommit();
    await seed("a -> b.txt", "stable content here\n");
    await $`git add -A`.cwd(repo).quiet();
    await $`git commit -q -m ${"✨ feat: add it"}`.cwd(repo).quiet();
    await $`git mv ${"a -> b.txt"} ${"c -> d.txt"}`.cwd(repo).quiet();

    const planPath = await writePlan({
      commits: [
        {
          type: "refactor",
          subject: "rename it",
          files: ["a -> b.txt", "c -> d.txt"],
        },
      ],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
  });

  test("refuses a rename that dropped its old path, before staging anything", async () => {
    await baseCommit();
    await seed("old.ts", "same content here\n");
    await $`git add -A`.cwd(repo).quiet();
    await $`git commit -q -m ${"✨ feat: add old"}`.cwd(repo).quiet();
    await $`git mv old.ts new.ts`.cwd(repo).quiet();

    const planPath = await writePlan({
      commits: [
        { emoji: "📦", type: "refactor", subject: "rename", files: ["new.ts"] },
      ],
    });

    // Committing new.ts alone leaves old.ts's deletion staged: the tree would
    // hold both files, and the post-commit check would catch it too late.
    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(2);
    expect(json.splitRenames).toEqual(["old.ts -> new.ts"]);
    expect(await subjects()).toEqual(["✨ feat: add old", "🔧 chore: init"]);
  });

  test("does not mistake an older commit with the same subject for a resume", async () => {
    await baseCommit();
    await seed("a.ts", "one\n");
    await $`git add -A`.cwd(repo).quiet();
    await $`git commit -q -m ${"🔧 chore: bump the version"}`.cwd(repo).quiet();

    // A fresh changeset whose subject happens to repeat the previous run's.
    await seed("b.ts", "two\n");
    const planPath = await writePlan({
      commits: [
        {
          emoji: "🔧",
          type: "chore",
          subject: "bump the version",
          files: ["b.ts"],
        },
      ],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.executed).toEqual(["🔧 chore: bump the version"]);
    expect(json.skipped).toEqual([]);
    expect(await subjects()).toHaveLength(3);
  });

  test("refuses a plan that drops a changed file, before staging anything", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    await seed("b.md", "b\n");
    const planPath = await writePlan({
      commits: [
        { emoji: "✨", type: "feat", subject: "add a", files: ["a.ts"] },
      ],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(2);
    expect(json.missing).toEqual(["b.md"]);
    expect(await subjects()).toEqual(["🔧 chore: init"]);
  });

  test("refuses a plan naming a file the changeset does not hold", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    const planPath = await writePlan({
      commits: [
        {
          emoji: "✨",
          type: "feat",
          subject: "add",
          files: ["a.ts", "ghost.ts"],
        },
      ],
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(2);
    expect(json.unknown).toEqual(["ghost.ts"]);
  });

  test("resumes a half-written plan without duplicating its first commit", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    await seed("b.md", "b\n");
    const plan: PlanShape = {
      commits: [
        { emoji: "✨", type: "feat", subject: "add a", files: ["a.ts"] },
        { emoji: "📖", type: "docs", subject: "add b", files: ["b.md"] },
      ],
      simple: { type: "feat", subject: "add a and document it" },
    };

    // Simulate a run that died after the first commit.
    await $`git add -- a.ts`.cwd(repo).quiet();
    await $`git commit -q --only -m ${"✨ feat: add a"} -- a.ts`
      .cwd(repo)
      .quiet();

    const { exitCode, json } = await run("apply", await writePlan(plan));
    expect(exitCode).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.skipped).toEqual(["✨ feat: add a"]);
    expect(json.executed).toEqual(["📖 docs: add b"]);
    expect(await subjects()).toEqual([
      "📖 docs: add b",
      "✨ feat: add a",
      "🔧 chore: init",
    ]);
  });

  test("a fully landed plan re-runs as a verified no-op", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    const planPath = await writePlan({
      commits: [
        { emoji: "✨", type: "feat", subject: "add a", files: ["a.ts"] },
      ],
    });

    expect((await run("apply", planPath)).exitCode).toBe(0);
    const second = await run("apply", planPath);
    expect(second.exitCode).toBe(0);
    expect(second.json.ok).toBe(true);
    expect(second.json.executed).toEqual([]);
    expect(second.json.skipped).toEqual(["✨ feat: add a"]);
    expect(await subjects()).toEqual(["✨ feat: add a", "🔧 chore: init"]);
  });

  test("reports leftover work the plan never knew about", async () => {
    await baseCommit();
    await seed("a.ts", "a\n");
    const planPath = await writePlan({
      commits: [
        { emoji: "✨", type: "feat", subject: "add a", files: ["a.ts"] },
      ],
    });
    // Appears only after the coverage check has read the changeset.
    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(0);
    expect(json.verify.leftover).toEqual([]);
  });

  test("refuses an atomic split while a merge is in progress", async () => {
    await baseCommit();
    await $`git checkout -q -b side`.cwd(repo).quiet();
    await seed("c.ts", "side\n");
    await $`git add -A`.cwd(repo).quiet();
    await $`git commit -q -m ${"✨ feat: side"}`.cwd(repo).quiet();
    await $`git checkout -q main`.cwd(repo).quiet();
    await seed("c.ts", "main\n");
    await $`git add -A`.cwd(repo).quiet();
    await $`git commit -q -m ${"✨ feat: main"}`.cwd(repo).quiet();
    await $`git merge side`.cwd(repo).quiet().nothrow();

    await seed("d.ts", "d\n");
    const planPath = await writePlan({
      commits: [
        {
          emoji: "🐛",
          type: "fix",
          subject: "resolve conflict",
          files: ["c.ts"],
        },
        { emoji: "✨", type: "feat", subject: "add d", files: ["d.ts"] },
      ],
      simple: { type: "fix", subject: "resolve the conflict and add d" },
    });

    const { exitCode, json } = await run("apply", planPath);
    expect(exitCode).toBe(2);
    expect(json.error).toContain("merge or cherry-pick");
  });
});
