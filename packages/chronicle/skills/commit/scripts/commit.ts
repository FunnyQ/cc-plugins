#!/usr/bin/env bun

/**
 * The commit executor.
 *
 * Everything a commit run does mechanically — check the plan, decide the shape,
 * check it covers the changeset, stage, commit, verify — happens here, in one
 * process, from one file on disk. Only two judgements are left outside it:
 * grouping the diff and writing the prose.
 *
 * The plan arrives as a file rather than as an agent's final message, because a
 * run that answered in prose used to strand the whole flow. It carries the split
 * *and* the message those groups collapse into, so the shape is settled here
 * without a second round trip back to the agent to write the other one.
 *
 * Usage:
 *   bun commit.ts apply --plan-file <path>   # → { ok, shape, reasons, executed, verify }
 *
 * Exit codes: 0 done · 2 refused (bad proposal or plan, or a shape git will not accept)
 *             3 committed but the changeset did not land intact
 *
 * `apply` re-runs cleanly. It reads how much of the plan is already at HEAD off
 * the log rather than off a stored flag, so a run interrupted between commits
 * finishes the rest instead of writing the first half twice.
 */

import { $ } from "bun";
import { existsSync, realpathSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  committedPathsSince,
  parseStatus,
  remainingPaths,
  verifyPlanLanded,
  type ParsedStatus,
} from "./analyze-changes";
import {
  composeMessage,
  decideShape,
  resolveResumption,
  resolveShapedCommits,
  subjectOf,
  validatePlan,
  validatePlanFile,
  type CommitPlan,
  type LogEntry,
  type PlanDraft,
  type PlannedCommit,
} from "./commit-plan";

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

/**
 * Whether a path lands inside the repo, symlinked prefixes and all.
 *
 * Both sides are resolved: `main` chdir'd to the git root, which the OS may
 * report through its real path (`/private/var/…`) while the caller passes the
 * symlinked one (`/var/…`). Comparing the raw strings would call an in-repo file
 * external and let it through the guard below.
 */
function insideRepo(absolute: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const root = real(process.cwd());
  const holder = real(dirname(absolute));
  return holder === root || holder.startsWith(`${root}${sep}`);
}

/**
 * A plan file living in the tree is itself an unassigned change, and the
 * coverage check would then reject the plan for not planning its own plan.
 */
async function readPlanFile(path: string): Promise<PlanDraft> {
  const absolute = resolve(path);
  if (insideRepo(absolute)) {
    refuse(`the plan file must live outside the repo, not at ${absolute}`);
  }

  const file = Bun.file(absolute);
  if (!(await file.exists())) refuse(`no plan file at ${path}`);

  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch (error) {
    refuse(`plan file is not JSON — ${(error as Error).message}`);
  }

  const errors = validatePlanFile(raw);
  if (errors.length > 0) {
    refuse("the plan is not usable — fix the file and re-run", { errors });
  }
  return raw as PlanDraft;
}

async function readChangeset(): Promise<ParsedStatus[]> {
  // -z, because ` -> ` and newlines are both legal in a filename. See
  // parseStatusRecords.
  return parseStatus(await git("status", "--porcelain", "-uall", "-z"));
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
          "show",
          "--name-only",
          "--no-renames",
          "--format=",
          "-z",
          sha,
        )
      )
        .split("\0")
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
 *
 * `cached` is read once for the whole run: the plan assigns every path to exactly
 * one commit, so staging can only ever take paths out of the index, never add one
 * that a later commit still needs to match.
 */
function stageable(files: string[], cached: Set<string>): string[] {
  return files.filter((path) => existsSync(path) || cached.has(path));
}

async function cachedPaths(): Promise<Set<string>> {
  return new Set(
    (await gitOrEmpty("ls-files", "--cached", "-z"))
      .split("\0")
      .filter(Boolean),
  );
}

async function writeCommit(
  commit: PlannedCommit,
  index: number,
  duringMerge: boolean,
  cached: Set<string>,
): Promise<void> {
  // Kept on failure on purpose: the message is the part of a broken run that is
  // expensive to reproduce, and the reported path is how the user recovers it.
  const messagePath = join(
    tmpdir(),
    `chronicle-commit-${process.pid}-${index}.txt`,
  );
  await Bun.write(messagePath, composeMessage(commit));

  const toStage = stageable(commit.files, cached);
  if (toStage.length > 0) await git("add", "--", ...toStage);
  if (duringMerge) {
    await git("commit", "-F", messagePath);
  } else {
    await git("commit", "--only", "-F", messagePath, "--", ...commit.files);
  }
  await unlink(messagePath).catch(() => {});
}

async function applyMain(planPath: string): Promise<void> {
  const plan = await readPlanFile(planPath);
  const decision = decideShape(
    plan.commits.map((commit) => commit.type),
    {
      mode: plan.mode === "simple" ? "simple" : "auto",
      totalFiles:
        Number(plan.totalFiles) ||
        new Set(plan.commits.flatMap((commit) => commit.files)).size,
      moduleSpread: plan.moduleSpread ?? [],
    },
  );
  const commits = resolveShapedCommits(plan, decision.shape);

  const emptyTree = (
    await git("hash-object", "-t", "tree", "/dev/null")
  ).trim();
  const log = await readLog(commits.length + 1);
  const { landed, base } = resolveResumption(
    log,
    { shape: decision.shape, commits } satisfies CommitPlan,
    emptyTree,
  );
  const pending = commits.slice(landed);

  if (pending.length > 0) {
    const coverage = validatePlan(
      { shape: decision.shape, commits: pending },
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

    const cached = await cachedPaths();
    for (const [offset, commit] of pending.entries()) {
      try {
        await writeCommit(commit, landed + offset, duringMerge, cached);
      } catch (error) {
        refuse((error as Error).message, {
          executed: offset,
          note: "earlier commits stand; re-run to finish the rest",
        });
      }
    }
  }

  const planned = commits.flatMap((commit) => commit.files);
  const [committed, remaining] = await Promise.all([
    committedPathsSince(base),
    remainingPaths(),
  ]);
  const verification = verifyPlanLanded(planned, committed, remaining);

  const result = {
    ok: verification.ok,
    ...decision,
    base,
    executed: pending.map(subjectOf),
    skipped: commits.slice(0, landed).map(subjectOf),
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

  const index = process.argv.indexOf("--plan-file");
  const planPath = index === -1 ? "" : (process.argv[index + 1] ?? "");

  if (process.argv[2] !== "apply" || !planPath) {
    console.error("usage: commit.ts apply --plan-file <path>");
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
