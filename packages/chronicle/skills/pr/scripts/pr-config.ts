#!/usr/bin/env bun
import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PrConfig =
  | { workflow: "github-flow"; base: string }
  | {
      workflow: "git-flow";
      production: string;
      development: string;
    };

type FirstRunFacts = {
  configPath: string;
  branch: string;
  defaultBranch: string;
  hasDevelop: boolean;
  productionBranch: string | null;
};

export type FirstRunState = {
  status: "needs-setup";
  configPath: string;
  branch: string;
  defaultBranch: string;
  suggestions: PrConfig[];
};

export type ConfiguredState = {
  status: "configured";
  configPath: string;
  branch: string;
  base: string;
  config: PrConfig;
  commit?: string;
};

const CONFIG_COMMIT_MESSAGE = `🔧 chore: Configure Chronicle PR workflow

- Persist the repository's selected PR workflow and branch targets

---

保存 Chronicle PR 工作流程設定，讓後續執行能直接解析目標分支。`;

export function configCommitArgs(configPath: string): string[] {
  return ["commit", "--only", "-m", CONFIG_COMMIT_MESSAGE, "--", configPath];
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid PR config: ${field} must be a non-empty string`);
  }
  return value.trim();
}

export function parsePrConfig(text: string): PrConfig {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (raw?.workflow === "github-flow") {
    return {
      workflow: "github-flow",
      base: nonEmptyString(raw.base, "base"),
    };
  }
  if (raw?.workflow === "git-flow") {
    return {
      workflow: "git-flow",
      production: nonEmptyString(raw.production, "production"),
      development: nonEmptyString(raw.development, "development"),
    };
  }
  throw new Error(
    `invalid PR config: unknown workflow ${String(raw?.workflow)}`,
  );
}

export function serializePrConfig(config: PrConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}

export function resolveConfiguredBase(
  config: PrConfig,
  branch: string,
): string {
  if (config.workflow === "github-flow") return config.base;
  return /^(hotfix|release)[/-]/.test(branch)
    ? config.production
    : config.development;
}

export function selectProductionBranch(
  defaultBranch: string,
  refs: { hasMain: boolean; hasMaster: boolean },
): string | null {
  if (defaultBranch !== "develop") return defaultBranch;
  if (refs.hasMain) return "main";
  if (refs.hasMaster) return "master";
  return null;
}

export function buildFirstRunState(facts: FirstRunFacts): FirstRunState {
  const suggestions: PrConfig[] = [
    { workflow: "github-flow", base: facts.defaultBranch },
  ];
  if (facts.hasDevelop && facts.productionBranch) {
    suggestions.push({
      workflow: "git-flow",
      production: facts.productionBranch,
      development: "develop",
    });
  }
  return {
    status: "needs-setup",
    configPath: facts.configPath,
    branch: facts.branch,
    defaultBranch: facts.defaultBranch,
    suggestions,
  };
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

async function branchExists(name: string): Promise<boolean> {
  return !!(
    (await tryGitText([
      "rev-parse",
      "--verify",
      "--quiet",
      `origin/${name}`,
    ])) || (await tryGitText(["rev-parse", "--verify", "--quiet", name]))
  );
}

async function remoteDefaultBranch(): Promise<string> {
  const ref = await tryGitText(["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (ref) return ref.trim().replace(/^refs\/remotes\/origin\//, "");
  if (await branchExists("main")) return "main";
  if (await branchExists("master")) return "master";
  return "main";
}

async function repoFacts(): Promise<{
  repoRoot: string;
  branch: string;
  configPath: string;
}> {
  const [repoRoot, branch] = await Promise.all([
    gitText(["rev-parse", "--show-toplevel"]),
    gitText(["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  const root = repoRoot.trim();
  return {
    repoRoot: root,
    branch: branch.trim(),
    configPath: join(root, ".chronicle", "pr.json"),
  };
}

export async function inspectPrConfig(): Promise<
  FirstRunState | ConfiguredState
> {
  const facts = await repoFacts();
  const file = Bun.file(facts.configPath);
  if (await file.exists()) {
    const config = parsePrConfig(await file.text());
    return {
      status: "configured",
      configPath: facts.configPath,
      branch: facts.branch,
      base: resolveConfiguredBase(config, facts.branch),
      config,
    };
  }

  const [defaultBranch, hasDevelop, hasMain, hasMaster] = await Promise.all([
    remoteDefaultBranch(),
    branchExists("develop"),
    branchExists("main"),
    branchExists("master"),
  ]);
  return buildFirstRunState({
    configPath: facts.configPath,
    branch: facts.branch,
    defaultBranch,
    hasDevelop,
    productionBranch: selectProductionBranch(defaultBranch, {
      hasMain,
      hasMaster,
    }),
  });
}

export async function savePrConfig(
  config: PrConfig,
  commit = false,
): Promise<ConfiguredState> {
  const facts = await repoFacts();
  await mkdir(dirname(facts.configPath), { recursive: true });
  await Bun.write(facts.configPath, serializePrConfig(config));
  let commitSha: string | undefined;
  if (commit) {
    await gitText(["add", "--", facts.configPath]);
    await gitText(configCommitArgs(facts.configPath));
    commitSha = (await gitText(["rev-parse", "HEAD"])).trim();
  }
  return {
    status: "configured",
    configPath: facts.configPath,
    branch: facts.branch,
    base: resolveConfiguredBase(config, facts.branch),
    config,
    ...(commitSha ? { commit: commitSha } : {}),
  };
}

function configFromArgs(argv: string[]): PrConfig {
  const workflow = argv[1];
  if (workflow === "github-flow") {
    return {
      workflow,
      base: nonEmptyString(argv[2], "base"),
    };
  }
  if (workflow === "git-flow") {
    return {
      workflow,
      production: nonEmptyString(argv[2], "production"),
      development: nonEmptyString(argv[3], "development"),
    };
  }
  throw new Error(`unknown save workflow ${String(workflow)}`);
}

async function main(): Promise<void> {
  try {
    const argv = Bun.argv.slice(2);
    const result =
      argv[0] === "save"
        ? await savePrConfig(configFromArgs(argv), argv.includes("--commit"))
        : await inspectPrConfig();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
