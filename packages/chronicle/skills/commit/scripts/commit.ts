#!/usr/bin/env bun

/**
 * The commit executor.
 *
 * Everything a commit run does mechanically — decide the shape, check the plan
 * covers the changeset, stage, commit, verify — happens here, in one process,
 * from one file on disk. Only two judgements are left outside it: grouping the
 * diff (the watcher) and writing the prose (the main agent, which is the only
 * party that holds the "why").
 *
 * Usage:
 *   bun commit.ts shape --types feat,fix --total-files 7 --modules a,b [--mode simple]
 *   bun commit.ts apply --plan-file <path>   # → { ok, executed, skipped, verify }
 *
 * Exit codes: 0 done · 2 refused (bad plan, or a shape git will not accept)
 *             3 committed but the changeset did not land intact
 *
 * `apply` re-runs cleanly. It reads how much of the plan is already at HEAD off
 * the log rather than off a stored flag, so a run interrupted between commits
 * finishes the rest instead of writing the first half twice.
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  committedPathsSince,
  parseStatusLine,
  remainingPaths,
  verifyPlanLanded,
  type ParsedStatus,
} from "./analyze-changes";
import {
  composeMessage,
  decideShape,
  resolveResumption,
  validatePlan,
  type CommitPlan,
  type LogEntry,
  type PlannedCommit,
} from "./commit-plan";

/** The one artifact `apply` reads: the shaped plan, prose and all. */
type PlanFile = {
  shape?: "simple" | "atomic";
  commits: PlannedCommit[];
};

function emit(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function refuse(error: string, extra: Record<string, unknown> = {}): never {
  emit({ ok: false, error, ...extra });
  process.exit(2);
}

async function git(...args: string[]): Promise<string> {
  const result = await $`git ${args}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`git ${args.join(" ")} — ${detail}`);
  }
  return result.stdout.toString();
}

async function gitOrEmpty(...args: string[]): Promise<string> {
  return await git(...args).catch(() => "");
}

async function readPlanFile(path: string): Promise<PlanFile> {
  // A plan file inside the repo is itself an unassigned change, and the coverage
  // check would then reject the plan for not planning its own plan.
  const absolute = resolve(path);
  if (absolute.startsWith(`${process.cwd()}${sep}`)) {
    refuse(`the plan file must live outside the repo, not at ${absolute}`);
  }

  const file = Bun.file(absolute);
  if (!(await file.exists())) refuse(`no plan file at ${path}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    refuse(`plan file is not JSON — ${(error as Error).message}`);
  }

  const plan = parsed as PlanFile;
  if (!Array.isArray(plan?.commits) || plan.commits.length === 0) {
    refuse("plan file holds no commits");
  }
  return plan;
}

async function readChangeset(): Promise<ParsedStatus[]> {
  // See analyzeChanges: without core.quotePath=false a non-ASCII path comes back
  // octal-escaped, and the coverage check then rejects a plan that is correct.
  const status = (
    await git("-c", "core.quotePath=false", "status", "--porcelain", "-uall")
  ).trimEnd();
  return status ? status.split("\n").flatMap(parseStatusLine) : [];
}

/**
 * Newest-first, capped just past the plan so a resume can see the commit before
 * it. Each entry carries the paths it changed, because the resume check needs
 * them as identity — a subject on its own is not unique across runs.
 */
async function readLog(limit: number): Promise<LogEntry[]> {
  const output = (
    await gitOrEmpty("log", "--format=%H%x1f%s", "-n", String(limit))
  ).trimEnd();
  if (!output) return [];

  const heads = output.split("\n").map((line) => {
    const [sha = "", subject = ""] = line.split("\x1f");
    return { sha, subject };
  });

  return await Promise.all(
    heads.map(async ({ sha, subject }) => ({
      sha,
      subject,
      // --no-renames keeps both halves of a rename, matching how a plan carries them.
      paths: (
        await gitOrEmpty(
          "-c",
          "core.quotePath=false",
          "show",
          "--name-only",
          "--no-renames",
          "--format=",
          sha,
        )
      )
        .trimEnd()
        .split("\n")
        .filter(Boolean),
    })),
  );
}

/**
 * Git demands the whole index for a conflict-resolution commit, so `--only` and
 * a pathspec have to come off. That also means a merge can carry exactly one
 * commit — the first would swallow every other commit's files.
 */
async function mergeInProgress(): Promise<boolean> {
  const gitDir = (await git("rev-parse", "--git-dir")).trim();
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (await Bun.file(join(gitDir, marker)).exists()) return true;
  }
  return false;
}

/**
 * The subset of a commit's files that `git add` can match.
 *
 * A rename that is already staged leaves its old path in neither the worktree
 * nor the index, and `git add` fails the whole invocation on one unmatched
 * pathspec. The old path still belongs in the *commit* pathspec — that is what
 * keeps the deletion in the same commit — so it is dropped here and only here.
 */
async function stageable(files: string[]): Promise<string[]> {
  const cached = new Set(
    (await gitOrEmpty("ls-files", "--cached", "--", ...files))
      .trimEnd()
      .split("\n")
      .filter(Boolean),
  );
  const present = await Promise.all(
    files.map(async (path) => existsSync(path) || cached.has(path)),
  );
  return files.filter((_, index) => present[index]);
}

async function writeCommit(
  commit: PlannedCommit,
  index: number,
  duringMerge: boolean,
): Promise<void> {
  // Kept on failure on purpose: the message is the part of a broken run that is
  // expensive to reproduce, and the reported path is how the user recovers it.
  const messagePath = join(
    tmpdir(),
    `chronicle-commit-${process.pid}-${index}.txt`,
  );
  await Bun.write(messagePath, composeMessage(commit));

  const toStage = await stageable(commit.files);
  if (toStage.length > 0) await git("add", "--", ...toStage);
  if (duringMerge) {
    await git("commit", "-F", messagePath);
  } else {
    await git("commit", "--only", "-F", messagePath, "--", ...commit.files);
  }
  await unlink(messagePath).catch(() => {});
}

/**
 * Scalars, not a file: the shape is settled before any prose exists, and the
 * decision needs only the group types, the file count, and the module spread.
 * That lets the watcher answer it in the same turn it proposes the groups.
 */
function shapeMain(argv: string[]): void {
  const flag = (name: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? "" : (argv[index + 1] ?? "");
  };
  const list = (name: string): string[] =>
    flag(name)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  const types = list("types");
  if (types.length === 0) {
    console.error(
      "usage: commit.ts shape --types <a,b> [--total-files <n>] [--modules <a,b>] [--mode auto|simple]",
    );
    process.exit(2);
  }

  emit(
    decideShape(types, {
      mode: flag("mode") === "simple" ? "simple" : "auto",
      totalFiles: Number(flag("total-files")) || types.length,
      moduleSpread: list("modules"),
    }),
  );
}

async function applyMain(planPath: string): Promise<void> {
  const plan = await readPlanFile(planPath);
  if (plan.shape !== "simple" && plan.shape !== "atomic") {
    refuse("plan file has no shape — run `commit.ts shape` first");
  }
  if (plan.shape === "simple" && plan.commits.length > 1) {
    refuse(`shape is simple but the plan holds ${plan.commits.length} commits`);
  }

  const emptyTree = (
    await git("hash-object", "-t", "tree", "/dev/null")
  ).trim();
  const log = await readLog(plan.commits.length + 1);
  const { landed, base } = resolveResumption(
    log,
    plan as CommitPlan,
    emptyTree,
  );
  const pending = plan.commits.slice(landed);

  if (pending.length > 0) {
    const coverage = validatePlan(
      { shape: plan.shape, commits: pending },
      await readChangeset(),
    );
    if (!coverage.ok) {
      refuse("the plan does not cover the changeset exactly once", coverage);
    }

    const duringMerge = await mergeInProgress();
    if (duringMerge && pending.length > 1) {
      refuse(
        `a merge or cherry-pick is in progress — it can carry one commit, not ${pending.length}`,
      );
    }

    for (const [offset, commit] of pending.entries()) {
      try {
        await writeCommit(commit, landed + offset, duringMerge);
      } catch (error) {
        refuse((error as Error).message, {
          executed: offset,
          note: "earlier commits stand; re-run to finish the rest",
        });
      }
    }
  }

  const planned = plan.commits.flatMap((commit) => commit.files);
  const [committed, remaining] = await Promise.all([
    committedPathsSince(base),
    remainingPaths(),
  ]);
  const verification = verifyPlanLanded(planned, committed, remaining);

  const result = {
    ok: verification.ok,
    shape: plan.shape,
    base,
    executed: pending.map((commit) => composeMessage(commit).split("\n")[0]),
    skipped: plan.commits
      .slice(0, landed)
      .map((commit) => composeMessage(commit).split("\n")[0]),
    log: (await gitOrEmpty("log", "--oneline", `${base}..HEAD`))
      .trimEnd()
      .split("\n"),
    verify: {
      plannedFiles: new Set(planned).size,
      committedFiles: committed.length,
      ...verification,
    },
  };

  emit(result);
  if (!verification.ok) process.exit(3);
}

async function main(): Promise<void> {
  const repoRoot = (await gitOrEmpty("rev-parse", "--show-toplevel")).trim();
  if (repoRoot) process.chdir(repoRoot);

  const command = process.argv[2];
  if (command === "shape") return shapeMain(process.argv);

  const flagIndex = process.argv.indexOf("--plan-file");
  const planPath = flagIndex === -1 ? "" : (process.argv[flagIndex + 1] ?? "");
  if (command !== "apply" || !planPath) {
    console.error(
      "usage: commit.ts shape --types <a,b> [...]\n       commit.ts apply --plan-file <path>",
    );
    process.exit(2);
  }

  return await applyMain(planPath);
}

if (import.meta.main) {
  main().catch((error: Error) => {
    emit({ ok: false, error: error.message });
    process.exit(2);
  });
}
