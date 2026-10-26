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
 * versions). This engine never prompts and never spawns anything. `plan` changes
 * nothing, but it does run each declared artifact's version command — asking a
 * committed binary what it is, is the only way to know.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { $, type ShellExpression } from "bun";

import {
  allTags,
  apply as applyVersion,
  artifactCommand,
  effectiveWorkflow,
  git,
  loadConfig,
  releaseBranchFor,
  repoRoot,
  saveConfig,
  versionInOutput,
  type ArtifactSpec,
  type ReleaseConfig,
  type Workflow,
} from "./analyze-release";
import {
  classifyJudged,
  gatherFacts,
  renderEntry,
  spliceEntries,
  validateEntries,
  type EntryDraft,
} from "./changelog";
import { writeTempPayload } from "../../../shared/scripts/temp-payload";
import { renderJevLine } from "../../../shared/scripts/typesafe";
import {
  artifactsDone,
  bumpDone,
  commitDone,
  deriveUnits,
  entryDone,
  stagesFor,
  tagState,
  touchedFiles,
  type ArtifactOutputs,
  type FileContents,
  type StageId,
  type Unit,
  type VersionChoice,
} from "./stages";

export type StageState = "done" | "pending" | "blocked";

export type StageReport = {
  id: StageId;
  state: StageState;
  note?: string;
};

export type Plan = {
  workflow: Workflow;
  branch: string;
  head: string;
  releaseCommit: string;
  changelogPath: string;
  units: Unit[];
  files: string[];
  subject: string;
  stages: StageReport[];
};

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

/**
 * What every declared artifact says its version is.
 *
 * Runs each artifact's version command in the repo root and keeps stdout and
 * stderr together — plenty of tools print `--version` to stderr. A command that
 * exits non-zero, or prints nothing, reads as null: unanswerable, never passed.
 */
async function readArtifactOutputs(
  root: string,
  units: Unit[],
): Promise<ArtifactOutputs> {
  const specs = new Map<string, ArtifactSpec>();
  for (const unit of units) {
    for (const artifact of unit.artifacts) specs.set(artifact.path, artifact);
  }
  const out: ArtifactOutputs = {};
  await Promise.all(
    [...specs.values()].map(async (artifact) => {
      const command = artifactCommand(artifact);
      const result = await $`sh -c ${command}`.cwd(root).quiet().nothrow();
      const text = (result.stdout.toString() + result.stderr.toString()).trim();
      out[artifact.path] = result.exitCode === 0 && text ? text : null;
    }),
  );
  return out;
}

function artifactNote(units: Unit[], outputs: ArtifactOutputs): string {
  const stale: string[] = [];
  for (const unit of units) {
    for (const artifact of unit.artifacts) {
      const out = outputs[artifact.path];
      if (out == null) {
        stale.push(`${artifact.path}: \`${artifactCommand(artifact)}\` failed`);
      } else if (!versionInOutput(out, unit.targetVersion)) {
        stale.push(
          `${artifact.path}: reports "${out.split("\n")[0].slice(0, 60)}", expected ${unit.targetVersion}`,
        );
      }
    }
  }
  return `stale committed build output — ${stale.join("; ")}`;
}

async function contains(branch: string, other: string): Promise<boolean> {
  const a = await git`git rev-parse --verify -q ${branch}`;
  const b = await git`git rev-parse --verify -q ${other}`;
  if (!a || !b) return false;
  return (
    (await git`git merge-base --is-ancestor ${other} ${branch} && echo yes`) ===
    "yes"
  );
}

let remote: Promise<boolean> | null = null;

function hasRemote(): Promise<boolean> {
  return (remote ??= git`git remote get-url origin`.then(Boolean));
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

async function tagsOnRemote(names: string[]): Promise<boolean> {
  if (!(await hasRemote())) return false;
  // One query for every name — a per-name loop paid the ~3s round-trip N times.
  // Never spawn with an empty list: bare `--tags` would match every tag.
  if (names.length === 0) return true;
  const listed = await git`git ls-remote --tags origin ${names}`;
  const found = new Set(
    listed
      .split("\n")
      .map((line) => line.split("\t")[1] ?? "")
      .map((ref) => ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "")),
  );
  return names.every((n) => found.has(n));
}

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

  const [changelog, headChangelog, savedConfig, artifactOutputs] =
    await Promise.all([
      readFile(resolve(root, config.changelog), "utf-8").catch(() => ""),
      git`git show HEAD:${config.changelog}`,
      loadConfig(root),
      readArtifactOutputs(root, units),
    ]);
  const configOnDisk = savedConfig != null;

  const workflow = effectiveWorkflow(config);
  const every = (fn: (u: Unit) => boolean) => units.every(fn);

  const main = config.branches.main;
  const develop = config.branches.develop;
  const [mainContainsDevelop, developContainsMain, pushed, mainHead, behind] =
    await Promise.all([
      workflow === "git-flow" && develop ? contains(main, develop) : true,
      workflow === "git-flow" && develop ? contains(develop, main) : true,
      tagsOnRemote(units.map((u) => u.tagName)),
      git`git rev-parse ${main}`,
      behindRemote(main),
    ]);

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
      case "artifacts": {
        const done = every((u) => artifactsDone(u, artifactOutputs));
        return done
          ? report(id, true)
          : {
              id,
              state: "pending",
              note: artifactNote(units, artifactOutputs),
            };
      }
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
    changelogPath: config.changelog,
    units,
    files,
    subject: releaseSubject(units),
    stages,
  };
}

function report(id: StageId, done: boolean): StageReport {
  return { id, state: done ? "done" : "pending" };
}

export type RunResult = {
  executed: StageId[];
  skipped: StageId[];
  releaseCommit: string;
  tags: string[];
  branch: string;
  workflow: Workflow;
  log: string;
};

async function shOrThrow(
  strings: TemplateStringsArray,
  ...v: ShellExpression[]
): Promise<string> {
  return (await $(strings, ...v).quiet()).stdout.toString().trim();
}

async function checkout(branch: string): Promise<void> {
  if ((await git`git branch --show-current`) !== branch) {
    await shOrThrow`git checkout ${branch}`;
  }
}

export async function run(
  config: ReleaseConfig,
  choices: VersionChoice[],
  opts: { persistConfig: boolean; through: StageId; entriesFile?: string },
): Promise<RunResult> {
  const root = await repoRoot();
  const main = config.branches.main;
  const develop = config.branches.develop;
  const workflow = effectiveWorkflow(config);
  const commitBranch = releaseBranchFor(config);

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

    await execute(id, config, current, {
      root,
      main,
      develop,
      commitBranch,
      entriesFile: opts.entriesFile,
    });

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
  ctx: {
    root: string;
    main: string;
    develop?: string;
    commitBranch: string;
    entriesFile?: string;
  },
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

    case "artifacts": {
      const note = p.stages.find((s) => s.id === "artifacts")?.note ?? "";
      const builds = new Set(
        p.units
          .flatMap((u) => u.artifacts)
          .flatMap((a) => (a.build ? [a.build] : [])),
      );
      if (builds.size === 0) {
        throw new Error(`${note} — rebuild it, then re-run`);
      }
      for (const build of builds) await shOrThrow`sh -c ${build}`;
      return;
    }

    case "entry": {
      if (!ctx.entriesFile) {
        throw new Error(
          `the CHANGELOG entry is missing for ${p.units
            .map((u) => u.headerLabel)
            .join(
              ", ",
            )} — run \`release.ts facts\`, spawn chronicle:annalist, then re-run with --entries-file`,
        );
      }
      const path = resolve(ctx.root, p.changelogPath);
      const changelog = await readFile(path, "utf-8").catch(() => "");
      const pending = p.units.filter((u) => !entryDone(u, changelog));
      const facts = await gatherFacts(pending);
      const tags = new Set(pending.map((u) => u.tagName));
      const drafts = (
        JSON.parse(await readFile(ctx.entriesFile, "utf-8")) as EntryDraft[]
      ).filter((d) => tags.has(d.tagName));
      const errors = validateEntries(drafts, facts);
      if (errors.length > 0) {
        throw new Error(`entries file rejected:\n  ${errors.join("\n  ")}`);
      }
      const date = new Date().toLocaleDateString("sv-SE");
      const blocks = pending.map((u) =>
        renderEntry(
          drafts.find((d) => d.tagName === u.tagName)!,
          u.headerLabel,
          date,
        ),
      );
      await writeFile(path, spliceEntries(changelog, blocks));
      return;
    }

    case "commit":
      await checkout(ctx.commitBranch);
      await shOrThrow`git add ${p.files}`;
      await shOrThrow`git commit -m ${p.subject}`;
      return;

    case "merge": {
      if (!ctx.develop) throw new Error("git-flow needs branches.develop");
      await checkout(ctx.main);
      const tags = p.units.map((u) => u.tagName).join(" + ");
      await shOrThrow`git merge --no-ff ${ctx.develop} -m ${`Merge branch '${ctx.develop}' for ${tags}`}`;
      return;
    }

    case "tag":
      await checkout(ctx.main);
      for (const unit of p.units) {
        await shOrThrow`git tag -a ${unit.tagName} -m ${unit.tagName}`;
      }
      return;

    case "back-merge":
      if (!ctx.develop) throw new Error("git-flow needs branches.develop");
      await checkout(ctx.develop);
      await shOrThrow`git merge --no-ff ${ctx.main} -m ${`Merge branch '${ctx.main}' back into ${ctx.develop}`}`;
      return;

    case "push": {
      if (!(await hasRemote())) {
        throw new Error("no origin remote — nothing to push to");
      }
      const branches = ctx.develop ? [ctx.main, ctx.develop] : [ctx.main];
      await shOrThrow`git push origin ${branches}`;
      await shOrThrow`git push origin ${p.units.map((u) => u.tagName)}`;
      return;
    }
  }
}

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

export function formatPlanDigest(plan: Plan): string {
  const lines = plan.units.map(
    (unit) =>
      `plan       ${unit.component ?? "repo"} ${unit.targetVersion} → ${unit.tagName}   on ${plan.releaseCommit.slice(0, 7)} (${plan.branch}, ${plan.workflow})`,
  );
  lines.push(
    `stages     ${plan.stages.map((stage) => (stage.state === "done" ? `${stage.id}✓` : stage.id)).join(" ")}`,
  );
  for (const stage of plan.stages) {
    if (stage.state === "blocked") {
      lines.push(`BLOCKED    ${stage.id}: ${stage.note ?? "no reason given"}`);
    }
  }
  lines.push(`files      ${plan.files.join(" ")}`);
  for (const unit of plan.units) {
    lines.push(
      `entry      ${plan.changelogPath} · header "${unit.headerLabel}" · scope ${unit.pathScope ?? "whole repo"} · since ${unit.lastTag ?? "the beginning"}`,
    );
  }
  lines.push(`subject    ${plan.subject}`);
  return lines.join("\n");
}

export function formatFactsDigest(
  facts: Awaited<ReturnType<typeof gatherFacts>>,
  path: string,
): string {
  if (facts.length === 0) return "facts      every entry already written";
  const lines = facts.map((unit) => {
    const judge = unit.commits.filter((c) => c.section === "judge").length;
    const byJev = unit.commits.filter((c) => c.judgedBy === "jev").length;
    const jev = byJev ? ` · ${byJev} suggested by Jev` : "";
    return `facts      ${unit.tagName} · ${unit.commits.length} commits · ${judge} to judge${jev}`;
  });
  lines.push(`payload    ${path}`);
  return lines.join("\n");
}

export function formatRunDigest(result: RunResult): string {
  return [
    `executed   ${result.executed.join(" ") || "nothing — every stage already done"}`,
    `skipped    ${result.skipped.join(" ") || "—"}`,
    `commit     ${result.releaseCommit.slice(0, 7)} on ${result.branch}`,
    `tags       ${result.tags.join(" ") || "—"}`,
  ].join("\n");
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      units: { type: "string" },
      through: { type: "string" },
      json: { type: "boolean" },
      "persist-config": { type: "boolean", default: false },
      "entries-file": { type: "string" },
    },
  });

  const command = positionals[0];
  if (command !== "plan" && command !== "run" && command !== "facts") {
    console.error(
      "usage: release.ts plan|facts|run --units <json> [--through <stage>] [--entries-file <path>]",
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
    console.log(
      values.json ? JSON.stringify(result, null, 2) : formatPlanDigest(result),
    );
    process.exit(result.stages.some((s) => s.state === "blocked") ? 1 : 0);
  }

  if (command === "facts") {
    const current = await plan(config, choices, { persistConfig });
    const changelog = await readFile(
      resolve(root, current.changelogPath),
      "utf-8",
    ).catch(() => "");
    const facts = await gatherFacts(
      current.units.filter((u) => !entryDone(u, changelog)),
    );
    const jev = await classifyJudged(facts, {
      apiKey: process.env.TYPESAFE_API_KEY,
    });
    const path = await writeTempPayload("release", "facts", facts);
    console.log(formatFactsDigest(facts, path));
    if (jev) console.log(renderJevLine("classify", jev));
    return;
  }

  if (!values.through) {
    console.error("--through <stage> is required for run");
    process.exit(2);
  }
  const result = await run(config, choices, {
    persistConfig,
    through: values.through as StageId,
    entriesFile: values["entries-file"],
  });
  console.log(
    values.json ? JSON.stringify(result, null, 2) : formatRunDigest(result),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("release error:", err.message);
    process.exit(2);
  });
}
