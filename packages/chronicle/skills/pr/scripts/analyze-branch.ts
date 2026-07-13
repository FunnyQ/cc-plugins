#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Provider = "github" | "gitlab" | "unknown";

export type DecisionRecord = {
  id: string;
  type: "decision";
  kind?: "decision" | "rationale" | "learning" | "caveat";
  source?: "agent" | "scribe";
  decision: string;
  reason: string;
  tradeoff: string;
  facets: { label: string; text: string }[];
  needs_your_call: boolean;
  options: string[];
  files: string[];
  diagram?: string;
  timestamp: string;
};

export type BranchMaterial = {
  provider: Provider;
  remoteUrl: string | null;
  base: string;
  head: string;
  // The repo the request must be opened against, when it cannot be inferred —
  // i.e. `origin` is upstream and the branch was pushed to a separate fork remote.
  // null in every other case; see resolveCrossFork.
  repo: string | null;
  mergeBase: string;
  commits: { sha: string; subject: string; body: string }[];
  diffStat: string;
  decisions: DecisionRecord[];
  error?: string;
};

type RegistryEntry = {
  project?: string;
  logPath?: string;
};

type CockpitHarvest = {
  decisions: DecisionRecord[];
  hasCockpit: boolean;
};

export function detectProvider(remoteUrl: string | null): Provider {
  if (!remoteUrl) return "unknown";

  const host = remoteHost(remoteUrl)?.toLowerCase() ?? "";
  if (host === "github.com") return "github";
  if (host === "gitlab.com" || host.includes("gitlab")) return "gitlab";

  return "unknown";
}

export function projectMatches(
  entryProject: string,
  repoRoot: string,
): boolean {
  return normalizePath(entryProject) === normalizePath(repoRoot);
}

// "owner/name" from any of the shapes git hands back:
//   https://host/owner/name(.git)  |  git@host:owner/name.git  |  ssh://git@host/owner/name
export function parseRepoSlug(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const match = remoteUrl.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function qualifyHead(
  branch: string,
  headSlug: string | null,
  baseSlug: string | null,
): string {
  if (!headSlug || !baseSlug || headSlug === baseSlug) return branch;
  return `${headSlug.split("/")[0]}:${branch}`;
}

// A fork contributor can be set up two ways, and only one of them needs our help:
//
//   origin = the fork      → `gh` already defaults the base repo to the parent.
//                            Emitting --repo here would open a fork→fork PR.
//   origin = upstream,     → `gh` has no way to know where the branch lives. It
//   branch pushed to a       reads a bare --head as a branch of the BASE repo,
//   separate fork remote     which does not exist, and the create fails.
//
// So we only speak up for the second case: qualify the head as `owner:branch` and
// name the target repo explicitly. Anything we cannot parse falls back to today's
// behavior rather than guessing.
//
// `owner:branch` is gh's syntax, and only gh's. glab reads `--source-branch` as a
// plain branch name (a cross-project MR needs --source-project, which the messenger
// does not speak yet), so on any non-GitHub provider we keep today's bare head
// rather than hand glab a head it cannot parse.
export function resolveCrossFork(
  branch: string,
  headRemoteUrl: string | null,
  originRemoteUrl: string | null,
  provider: Provider,
): { head: string; repo: string | null } {
  if (provider !== "github") return { head: branch, repo: null };
  const headSlug = parseRepoSlug(headRemoteUrl);
  const baseSlug = parseRepoSlug(originRemoteUrl);
  const crossFork = !!headSlug && !!baseSlug && headSlug !== baseSlug;

  return {
    head: qualifyHead(branch, headSlug, baseSlug),
    repo: crossFork ? baseSlug : null,
  };
}

// Git resolves where `git push` actually lands through a chain, not one key:
// branch.<name>.pushRemote → remote.pushDefault → branch.<name>.remote. Reading only
// the tracking remote misses the triangular workflow git's own docs recommend to fork
// contributors (fetch from upstream, push to the fork via remote.pushDefault).
export function pickPushRemote(candidates: {
  pushRemote: string | null;
  pushDefault: string | null;
  trackingRemote: string | null;
}): string | null {
  return (
    candidates.pushRemote?.trim() ||
    candidates.pushDefault?.trim() ||
    candidates.trackingRemote?.trim() ||
    null
  );
}

export function branchDecisions(
  records: DecisionRecord[],
  changedFiles: string[],
  sinceISO: string,
): DecisionRecord[] {
  const changed = new Set(changedFiles);
  // Compare instants, not strings. Cockpit logs timestamps in UTC ("…Z") while
  // git's %cI emits a local offset ("…+08:00"); a lexical `<` across those two
  // formats is meaningless (e.g. "12:59Z" < "16:48+08:00" though the first is
  // chronologically later), which silently dropped every in-branch decision for
  // any non-UTC user. Date.parse normalizes both to epoch ms; NaN comparisons are
  // false, so an unparseable timestamp falls through to the file filter rather
  // than being dropped.
  const since = Date.parse(sinceISO);

  return records.filter((record) => {
    if (Date.parse(record.timestamp) < since) return false;
    if (record.files.length === 0) return true;
    return record.files.some((file) => changed.has(file));
  });
}

function remoteHost(remoteUrl: string): string | null {
  try {
    return new URL(remoteUrl).hostname;
  } catch {
    const scpLike = remoteUrl.match(/^[^@]+@([^:]+):/);
    if (scpLike) return scpLike[1];

    const sshLike = remoteUrl.match(/^[^@]+@([^/]+)\//);
    return sshLike?.[1] ?? null;
  }
}

function normalizePath(path: string): string {
  return resolve(path.replace(/\/+$/, ""));
}

async function gitText(args: string[]): Promise<string> {
  return await $`git ${args}`.text();
}

async function tryGitText(args: string[]): Promise<string | null> {
  try {
    return await gitText(args);
  } catch {
    return null;
  }
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function resolveBase(override: string | null): Promise<string> {
  if (override) return override;

  const defaultRef = await tryGitText([
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
  ]);
  const defaultBranch = defaultRef
    ?.trim()
    .replace(/^refs\/remotes\/origin\//, "");
  if (defaultBranch) return defaultBranch;

  const develop = await tryGitText(["rev-parse", "--verify", "develop"]);
  if (develop) return "develop";

  return "main";
}

function parseArgs(argv: string[]): { base: string | null } {
  let base: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--base") {
      base = argv[index + 1] ?? null;
      index++;
    }
  }
  return { base };
}

function parseCommits(
  text: string,
): { sha: string; subject: string; body: string }[] {
  if (text.trim() === "") return [];

  return text
    .split("\x1e")
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => {
      const [sha = "", subject = "", body = ""] = entry.split("\x1f");
      return {
        sha: sha.trim(),
        subject: subject.trim(),
        body: body.trim(),
      };
    })
    .filter((commit) => commit.sha.length > 0);
}

async function gatherGit(baseOverride: string | null) {
  const repoRoot = (await gitText(["rev-parse", "--show-toplevel"])).trim();
  const base = await resolveBase(baseOverride);
  const mergeBase = (await gitText(["merge-base", base, "HEAD"])).trim();
  const [
    head,
    remoteText,
    commitsText,
    diffStat,
    changedFilesText,
    commitTimesText,
  ] = await Promise.all([
    gitText(["rev-parse", "--abbrev-ref", "HEAD"]),
    tryGitText(["remote", "get-url", "origin"]),
    gitText(["log", "--format=%H%x1f%s%x1f%b%x1e", `${mergeBase}..HEAD`]),
    gitText(["diff", "--stat", `${mergeBase}..HEAD`]),
    gitText(["diff", "--name-only", `${mergeBase}..HEAD`]),
    gitText(["log", "--reverse", "--format=%cI", `${mergeBase}..HEAD`]),
  ]);
  const remoteUrl = remoteText?.trim() || null;
  const commits = parseCommits(commitsText);
  const changedFiles = lines(changedFilesText);
  const commitTimes = lines(commitTimesText);
  const branch = head.trim();
  const crossFork = resolveCrossFork(
    branch,
    await headRemoteUrl(branch),
    remoteUrl,
    detectProvider(remoteUrl),
  );

  return {
    repoRoot,
    base,
    head: crossFork.head,
    repo: crossFork.repo,
    mergeBase,
    remoteUrl,
    commits,
    diffStat,
    changedFiles,
    branchStartISO: commitTimes[0] ?? null,
  };
}

// The remote this branch actually pushes to — which is NOT always `origin`, and not
// always the tracking remote either (see pickPushRemote for the resolution chain).
async function headRemoteUrl(branch: string): Promise<string | null> {
  const name = pickPushRemote({
    pushRemote: await tryGitText([
      "config",
      "--get",
      `branch.${branch}.pushRemote`,
    ]),
    pushDefault: await tryGitText(["config", "--get", "remote.pushDefault"]),
    trackingRemote: await tryGitText([
      "config",
      "--get",
      `branch.${branch}.remote`,
    ]),
  });
  if (!name) return null;
  // A branch can be configured to push to a URL rather than a named remote.
  if (name.includes(":") || name.includes("/")) return name;
  return (await tryGitText(["remote", "get-url", name]))?.trim() || null;
}

function isDecisionRecord(value: unknown): value is DecisionRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<DecisionRecord>;
  return (
    record.type === "decision" &&
    typeof record.id === "string" &&
    typeof record.decision === "string" &&
    typeof record.reason === "string" &&
    typeof record.tradeoff === "string" &&
    Array.isArray(record.facets) &&
    typeof record.needs_your_call === "boolean" &&
    Array.isArray(record.options) &&
    Array.isArray(record.files) &&
    typeof record.timestamp === "string"
  );
}

async function readDecisionLog(path: string): Promise<DecisionRecord[]> {
  const text = await Bun.file(path).text();
  const records: DecisionRecord[] = [];

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (isDecisionRecord(parsed)) records.push(parsed);
    } catch {
      continue;
    }
  }

  return records;
}

async function harvestCockpit(
  repoRoot: string,
  changedFiles: string[],
  branchStartISO: string | null,
): Promise<CockpitHarvest> {
  if (!branchStartISO) return { decisions: [], hasCockpit: false };

  const dataHome =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const cockpitHome =
    process.env.COCKPIT_HOME || join(dataHome, "q-lab", "cockpit");
  const registryPath = join(cockpitHome, "registry.json");
  if (!existsSync(registryPath)) {
    return { decisions: [], hasCockpit: false };
  }

  try {
    const registry = JSON.parse(await Bun.file(registryPath).text());
    const sessions = Array.isArray(registry?.sessions)
      ? (registry.sessions as RegistryEntry[])
      : [];
    const matching = sessions.filter(
      (entry) =>
        typeof entry.project === "string" &&
        typeof entry.logPath === "string" &&
        projectMatches(entry.project, repoRoot),
    );
    const records: DecisionRecord[] = [];

    for (const entry of matching) {
      try {
        records.push(...(await readDecisionLog(entry.logPath!)));
      } catch {
        return { decisions: [], hasCockpit: false };
      }
    }

    const scoped = branchDecisions(records, changedFiles, branchStartISO);
    const deduped = new Map<string, DecisionRecord>();
    for (const record of scoped) {
      if (!deduped.has(record.id)) deduped.set(record.id, record);
    }

    return {
      decisions: [...deduped.values()].sort((a, b) =>
        a.timestamp.localeCompare(b.timestamp),
      ),
      hasCockpit: true,
    };
  } catch {
    return { decisions: [], hasCockpit: false };
  }
}

async function writePayload(payload: BranchMaterial): Promise<string> {
  const outputDir = join("/tmp", "chronicle", "pr");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(
    outputDir,
    `branch-material-${Date.now()}-${process.pid}.json`,
  );
  await Bun.write(outputPath, JSON.stringify(payload, null, 2) + "\n");
  return outputPath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fallbackPayloadForError(error: unknown): BranchMaterial {
  return {
    provider: "unknown",
    remoteUrl: null,
    base: "",
    head: "",
    repo: null,
    mergeBase: "",
    commits: [],
    diffStat: "",
    decisions: [],
    error: errorMessage(error),
  };
}

async function main(): Promise<void> {
  try {
    const { base } = parseArgs(Bun.argv.slice(2));
    const git = await gatherGit(base);
    const cockpit = await harvestCockpit(
      git.repoRoot,
      git.changedFiles,
      git.branchStartISO,
    );
    const provider = detectProvider(git.remoteUrl);
    const payload: BranchMaterial = {
      provider,
      remoteUrl: git.remoteUrl,
      base: git.base,
      head: git.head,
      repo: git.repo,
      mergeBase: git.mergeBase,
      commits: git.commits,
      diffStat: git.diffStat,
      decisions: cockpit.decisions,
    };
    const outputPath = await writePayload(payload);

    console.log(
      JSON.stringify({
        outputPath,
        provider,
        hasCockpit: cockpit.hasCockpit,
        commitCount: payload.commits.length,
        crossFork: payload.repo !== null,
      }),
    );
  } catch (error) {
    const payload = fallbackPayloadForError(error);
    const outputPath = await writePayload(payload);
    console.log(
      JSON.stringify({
        outputPath,
        provider: "unknown",
        hasCockpit: false,
        commitCount: 0,
        error: payload.error,
      }),
    );
  }
}

if (import.meta.main) {
  await main();
}
