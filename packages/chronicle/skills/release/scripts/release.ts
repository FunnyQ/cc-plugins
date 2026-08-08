#!/usr/bin/env bun
/**
 * Chronicle release engine.
 *
 * Two commands over the stage model in `stages.ts`:
 *
 *   release.ts plan --units '<json>'                 # read-only: what is pending
 *   release.ts run  --units '<json>' --through <id>  # execute the pending stages
 *
 * `--through` is the mode. `entry` stops where prepare stops; `tag` finishes
 * locally; `push` publishes. There is no separate prepare/auto branch anywhere in
 * here — a stage that has already happened is skipped because the repo says so,
 * which is what lets a stopped prepare run be finished by a later `run`.
 *
 * The units come from the caller (the skill's main agent, after the human picks
 * versions). This engine never prompts and never spawns anything.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import {
  allTags,
  apply as applyVersion,
  git,
  loadConfig,
  repoRoot,
  saveConfig,
  type ReleaseConfig,
} from "./analyze-release";
import {
  bumpDone,
  commitDone,
  deriveUnits,
  entryDone,
  stagesFor,
  tagState,
  touchedFiles,
  type FileContents,
  type StageId,
  type Unit,
  type VersionChoice,
} from "./stages";

export type StageState = "done" | "pending" | "blocked";

export type StageReport = {
  id: StageId;
  state: StageState;
  /** Why it is blocked, or what it will do. One line, for a human. */
  note?: string;
};

export type Plan = {
  workflow: "git-flow" | "github-flow";
  branch: string;
  head: string;
  /** The commit every tag lands on: `main`'s HEAD. */
  releaseCommit: string;
  units: Unit[];
  files: string[];
  subject: string;
  stages: StageReport[];
};

// ---------------------------------------------------------------------------
// Repo reads — every I/O the stage checks need, gathered once
// ---------------------------------------------------------------------------

/** File contents as of the working tree. */
async function readWorkingTree(
  root: string,
  paths: string[],
): Promise<FileContents> {
  const out: FileContents = {};
  await Promise.all(
    paths.map(async (p) => {
      out[p] = await readFile(resolve(root, p), "utf-8").catch(() => null);
    }),
  );
  return out;
}

/**
 * The same paths as of HEAD. `git show HEAD:<path>` resolves against the repo
 * root — a `./` prefix would make it cwd-relative — so it matches the config's
 * root-relative paths whatever directory this runs in. An unborn HEAD, or a path
 * absent there, reads as null.
 */
async function readHead(paths: string[]): Promise<FileContents> {
  const out: FileContents = {};
  await Promise.all(
    paths.map(async (p) => {
      const content = await git`git show HEAD:${p}`;
      out[p] = content || null;
    }),
  );
  return out;
}

/** Tag name → the commit it points at, for the tags this release would cut. */
async function readTagTargets(
  names: string[],
): Promise<Record<string, string>> {
  const existing = new Set(await allTags());
  const out: Record<string, string> = {};
  await Promise.all(
    names
      .filter((n) => existing.has(n))
      .map(async (n) => {
        const sha = await git`git rev-list -n1 ${n}`;
        if (sha) out[n] = sha;
      }),
  );
  return out;
}

/** Whether `branch` already contains everything `other` has. */
async function contains(branch: string, other: string): Promise<boolean> {
  const a = await git`git rev-parse --verify -q ${branch}`;
  const b = await git`git rev-parse --verify -q ${other}`;
  if (!a || !b) return false;
  return (
    (await git`git merge-base --is-ancestor ${other} ${branch} && echo yes`) ===
    "yes"
  );
}

async function hasRemote(): Promise<boolean> {
  return Boolean(await git`git remote get-url origin`);
}

/**
 * How many commits `origin/<main>` has that local `<main>` lacks.
 *
 * A release whose PR was already merged on the remote is the usual way a local
 * `main` goes stale, and committing onto it puts the release on a commit the
 * remote will reject — after the tag has been cut. Fetching first turns that
 * into a refusal. A failed fetch counts as stale rather than current, because
 * comparing against a stale `origin/<main>` would pass for the wrong reason.
 */
async function behindRemote(main: string): Promise<number | null> {
  if (!(await hasRemote())) return 0;
  const fetched = await git`git fetch origin ${main} && echo yes`;
  if (fetched !== "yes") return null;
  const count = await git`git rev-list --count ${main}..origin/${main}`;
  return Number(count) || 0;
}

/** True only when every tag is already on the remote. No remote → nothing pushed. */
async function tagsOnRemote(names: string[]): Promise<boolean> {
  if (!(await hasRemote())) return false;
  for (const n of names) {
    if (!(await git`git ls-remote --tags origin ${n}`)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function releaseSubject(units: Unit[]): string {
  return `🔧 release: ${units.map((u) => u.headerLabel).join(" + ")}`;
}

export async function plan(
  config: ReleaseConfig,
  choices: VersionChoice[],
  opts: { persistConfig: boolean },
): Promise<Plan> {
  const root = await repoRoot();
  const units = deriveUnits(config, choices);
  const files = touchedFiles(units, config, opts);
  const versionPaths = units.flatMap((u) => u.versionFiles.map((f) => f.path));

  const [tree, head, headSha, branch, tagTargets] = await Promise.all([
    readWorkingTree(root, versionPaths),
    readHead(versionPaths),
    git`git rev-parse HEAD`,
    git`git branch --show-current`,
    readTagTargets(units.map((u) => u.tagName)),
  ]);

  const changelog =
    (await readFile(resolve(root, config.changelog), "utf-8").catch(
      () => "",
    )) || "";
  const headChangelog = (await git`git show HEAD:${config.changelog}`) || "";
  const configOnDisk = (await loadConfig(root)) != null;

  const workflow = config.workflow ?? "git-flow";
  const every = (fn: (u: Unit) => boolean) => units.every(fn);

  const main = config.branches.main;
  const develop = config.branches.develop;
  const [mainContainsDevelop, developContainsMain, pushed, mainHead] =
    await Promise.all([
      workflow === "git-flow" && develop ? contains(main, develop) : true,
      workflow === "git-flow" && develop ? contains(develop, main) : true,
      tagsOnRemote(units.map((u) => u.tagName)),
      git`git rev-parse ${main}`,
    ]);
  const behind = await behindRemote(main);

  // Every tag lands on `main` — the bump commit on github-flow, the develop→main
  // merge on git-flow — never on whatever branch this happens to run from.
  const releaseCommit = mainHead || headSha;

  const stages: StageReport[] = stagesFor(config, opts).map((id) => {
    switch (id) {
      case "save-config":
        return report(id, configOnDisk);
      case "bump":
        return report(
          id,
          every((u) => bumpDone(u, tree)),
        );
      case "entry":
        return report(
          id,
          every((u) => entryDone(u, changelog)),
        );
      case "commit": {
        const done = every((u) => commitDone(u, head, headChangelog));
        if (!done && behind !== 0) {
          return {
            id,
            state: "blocked",
            note:
              behind === null
                ? `cannot tell whether local ${main} is current — git fetch origin ${main} failed`
                : `local ${main} is ${behind} commit(s) behind origin/${main} — git pull --ff-only and re-run`,
          };
        }
        return report(id, done);
      }
      case "merge":
        return report(id, mainContainsDevelop);
      case "back-merge":
        return report(id, developContainsMain);
      case "tag": {
        const states = units.map((u) => tagState(u, tagTargets, releaseCommit));
        const conflict = states.findIndex((s) => s === "conflict");
        if (conflict >= 0) {
          return {
            id,
            state: "blocked",
            note: `tag ${units[conflict].tagName} already exists on another commit — never move it`,
          };
        }
        return report(
          id,
          states.every((s) => s === "correct"),
        );
      }
      case "push":
        return report(id, pushed);
    }
  });

  return {
    workflow,
    branch,
    head: headSha,
    releaseCommit,
    units,
    files,
    subject: releaseSubject(units),
    stages,
  };
}

function report(id: StageId, done: boolean): StageReport {
  return { id, state: done ? "done" : "pending" };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export type RunResult = {
  executed: StageId[];
  skipped: StageId[];
  releaseCommit: string;
  tags: string[];
  branch: string;
  workflow: "git-flow" | "github-flow";
  log: string;
};

/** Mutating git. Unlike `git`, this throws on a non-zero exit rather than "". */
async function sh(
  strings: TemplateStringsArray,
  ...v: unknown[]
): Promise<string> {
  return (await $({ raw: strings }, ...v).quiet()).stdout.toString().trim();
}

async function checkout(branch: string): Promise<void> {
  if ((await git`git branch --show-current`) !== branch) {
    await sh`git checkout ${branch}`;
  }
}

/**
 * Run every pending stage up to and including `through`.
 *
 * The repo is re-read after each mutation, so no stage ever acts on state an
 * earlier stage assumed. A stage that runs and does not then read as done is a
 * failure, not a no-op — that invariant is what catches an empty commit or a
 * merge that produced nothing, which are the two ways a release has silently
 * produced a tag pointing at the wrong thing.
 */
export async function run(
  config: ReleaseConfig,
  choices: VersionChoice[],
  opts: { persistConfig: boolean; through: StageId },
): Promise<RunResult> {
  const root = await repoRoot();
  const main = config.branches.main;
  const develop = config.branches.develop;
  const workflow = config.workflow ?? "git-flow";
  const commitBranch = workflow === "git-flow" ? (develop ?? main) : main;

  const order = stagesFor(config, opts);
  const limit = order.indexOf(opts.through);
  if (limit < 0) {
    throw new Error(
      `--through ${opts.through} is not a stage of this release (${order.join(", ")})`,
    );
  }

  const executed: StageId[] = [];
  const skipped: StageId[] = [];
  let current = await plan(config, choices, opts);

  for (const id of order.slice(0, limit + 1)) {
    const stage = current.stages.find((s) => s.id === id)!;
    if (stage.state === "done") {
      skipped.push(id);
      continue;
    }
    if (stage.state === "blocked") {
      throw new Error(`${id} is blocked: ${stage.note}`);
    }

    await execute(id, config, current, { root, main, develop, commitBranch });

    current = await plan(config, choices, opts);
    const after = current.stages.find((s) => s.id === id)!;
    if (after.state !== "done") {
      throw new Error(
        `${id} ran but the repo does not reflect it${after.note ? ` — ${after.note}` : ""}`,
      );
    }
    executed.push(id);
  }

  return {
    executed,
    skipped,
    releaseCommit: current.releaseCommit,
    tags: current.units.map((u) => u.tagName),
    branch: await git`git branch --show-current`,
    workflow,
    log: await git`git log --oneline -4`,
  };
}

async function execute(
  id: StageId,
  config: ReleaseConfig,
  p: Plan,
  ctx: { root: string; main: string; develop?: string; commitBranch: string },
): Promise<void> {
  switch (id) {
    case "save-config":
      await saveConfig(ctx.root, config);
      return;

    case "bump":
      for (const unit of p.units) {
        await applyVersion(ctx.root, unit.targetVersion, unit.versionFiles);
      }
      return;

    // The one stage this engine cannot do: turning commits into user-facing
    // prose is the annalist's job. Refusing here rather than committing keeps a
    // bumped tree from being tagged with no CHANGELOG entry behind it.
    case "entry":
      throw new Error(
        `the CHANGELOG entry is missing for ${p.units
          .map((u) => u.headerLabel)
          .join(", ")} — spawn chronicle:annalist to write it, then re-run`,
      );

    case "commit":
      await checkout(ctx.commitBranch);
      await sh`git add ${p.files}`;
      await sh`git commit -m ${p.subject}`;
      return;

    case "merge": {
      if (!ctx.develop) throw new Error("git-flow needs branches.develop");
      await checkout(ctx.main);
      const tags = p.units.map((u) => u.tagName).join(" + ");
      await sh`git merge --no-ff ${ctx.develop} -m ${`Merge branch '${ctx.develop}' for ${tags}`}`;
      return;
    }

    case "tag":
      await checkout(ctx.main);
      for (const unit of p.units) {
        await sh`git tag -a ${unit.tagName} -m ${unit.tagName}`;
      }
      return;

    case "back-merge":
      if (!ctx.develop) throw new Error("git-flow needs branches.develop");
      await checkout(ctx.develop);
      await sh`git merge --no-ff ${ctx.main} -m ${`Merge branch '${ctx.main}' back into ${ctx.develop}`}`;
      return;

    case "push": {
      if (!(await hasRemote())) {
        throw new Error("no origin remote — nothing to push to");
      }
      const branches = ctx.develop ? [ctx.main, ctx.develop] : [ctx.main];
      await sh`git push origin ${branches}`;
      await sh`git push origin ${p.units.map((u) => u.tagName)}`;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseChoices(raw: string): VersionChoice[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("--units must be a non-empty JSON array");
  }
  return parsed.map((c) => ({
    component: c.component ?? null,
    targetVersion: String(c.targetVersion),
    lastTag: c.lastTag ?? null,
  }));
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      units: { type: "string" },
      through: { type: "string" },
      "persist-config": { type: "boolean", default: false },
    },
  });

  const command = positionals[0];
  if (command !== "plan" && command !== "run") {
    console.error(
      "usage: release.ts plan|run --units <json> [--through <stage>]",
    );
    process.exit(2);
  }
  if (!values.units) {
    console.error("--units is required");
    process.exit(2);
  }

  const root = await repoRoot();
  const config = await loadConfig(root);
  if (!config) {
    console.error(
      "no .chronicle/release.json — run the release interview first",
    );
    process.exit(2);
  }

  const persistConfig = values["persist-config"] === true;
  const choices = parseChoices(values.units);

  if (command === "plan") {
    const result = await plan(config, choices, { persistConfig });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.stages.some((s) => s.state === "blocked") ? 1 : 0);
  }

  if (!values.through) {
    console.error("--through <stage> is required for run");
    process.exit(2);
  }
  const result = await run(config, choices, {
    persistConfig,
    through: values.through as StageId,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("release error:", err.message);
    process.exit(2);
  });
}
