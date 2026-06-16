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
  mergeBase: string;
  commits: { sha: string; subject: string; body: string }[];
  diffStat: string;
  decisions: DecisionRecord[];
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

export function branchDecisions(
  records: DecisionRecord[],
  changedFiles: string[],
  sinceISO: string,
): DecisionRecord[] {
  const changed = new Set(changedFiles);

  return records.filter((record) => {
    if (record.timestamp < sinceISO) return false;
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
  const head = (await gitText(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const remoteText = await tryGitText(["remote", "get-url", "origin"]);
  const remoteUrl = remoteText?.trim() || null;
  const commits = parseCommits(
    await gitText(["log", "--format=%H%x1f%s%x1f%b%x1e", `${mergeBase}..HEAD`]),
  );
  const diffStat = await gitText(["diff", "--stat", `${mergeBase}..HEAD`]);
  const changedFiles = lines(
    await gitText(["diff", "--name-only", `${mergeBase}..HEAD`]),
  );
  const commitTimes = lines(
    await gitText(["log", "--reverse", "--format=%cI", `${mergeBase}..HEAD`]),
  );

  return {
    repoRoot,
    base,
    head,
    mergeBase,
    remoteUrl,
    commits,
    diffStat,
    changedFiles,
    branchStartISO: commitTimes[0] ?? null,
  };
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

  const cockpitHome = process.env.COCKPIT_HOME || join(homedir(), ".cockpit");
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
      }),
    );
  } catch {
    const payload: BranchMaterial = {
      provider: "unknown",
      remoteUrl: null,
      base: "",
      head: "",
      mergeBase: "",
      commits: [],
      diffStat: "",
      decisions: [],
    };
    const outputPath = await writePayload(payload);
    console.log(
      JSON.stringify({
        outputPath,
        provider: "unknown",
        hasCockpit: false,
        commitCount: 0,
      }),
    );
  }
}

if (import.meta.main) {
  await main();
}
