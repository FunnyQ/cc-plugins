import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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

export type RegistryEntry = { project?: string; logPath?: string };

// Ported from packages/monitor/skills/cockpit/scripts/log-root.ts — chronicle cannot
// import across the plugin boundary. That file is the spec; keep this in sync by hand.
export type LogRootDeps = {
  gitRoot?: (cwd: string) => string | null;
};

// Ported from packages/monitor/skills/cockpit/scripts/registry.ts — chronicle cannot
// import across the plugin boundary. That file is the spec; keep this in sync by hand.
export const STALE_MS = 10 * 60 * 1000;

function isInside(root: string, child: string): boolean {
  const path = relative(root, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Ported from packages/monitor/skills/cockpit/scripts/log-root.ts — chronicle cannot
// import across the plugin boundary. That file is the spec; keep this in sync by hand.
export function gitRootOf(cwd: string): string | null {
  try {
    const result = spawnSync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    if (result.status !== 0) return null;
    const root = (result.stdout ?? "").trim();
    return root || null;
  } catch {
    return null;
  }
}

// Ported from packages/monitor/skills/cockpit/scripts/log-root.ts — chronicle cannot
// import across the plugin boundary. That file is the spec; keep this in sync by hand.
export function logRoot(cwd: string, deps: LogRootDeps = {}): string {
  const resolveGitRoot = deps.gitRoot ?? gitRootOf;
  const start = realpathOr(cwd);
  const resolvedRoot = resolveGitRoot(start);
  if (!resolvedRoot) return start;

  const root = realpathOr(resolvedRoot);
  if (start !== root && !isInside(root, start)) return root;

  let directory = start;
  for (;;) {
    if (isDir(join(directory, ".cockpit"))) return directory;
    if (directory === root) return root;
    const parent = dirname(directory);
    if (parent === directory) return root;
    directory = parent;
  }
}

export function normalizePath(path: string): string {
  return resolve(path.replace(/\/+$/, ""));
}

export function projectMatches(
  entryProject: string,
  repoRoot: string,
): boolean {
  return normalizePath(entryProject) === normalizePath(repoRoot);
}

export function isDecisionRecord(value: unknown): value is DecisionRecord {
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

export async function readDecisionLog(
  path: string,
): Promise<DecisionRecord[]> {
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

export async function collectDecisions(
  logPaths: string[],
  read: (path: string) => Promise<DecisionRecord[]> = readDecisionLog,
): Promise<DecisionRecord[]> {
  const records: DecisionRecord[] = [];

  for (const path of logPaths) {
    try {
      records.push(...(await read(path)));
    } catch {
      continue;
    }
  }

  return records;
}

export function cockpitHome(): string {
  const dataHome =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return process.env.COCKPIT_HOME || join(dataHome, "q-lab", "cockpit");
}

export function registryPath(): string {
  return join(cockpitHome(), "registry.json");
}

export async function readRegistrySessions(): Promise<RegistryEntry[]> {
  try {
    const registry = JSON.parse(await Bun.file(registryPath()).text());
    return Array.isArray(registry?.sessions) ? registry.sessions : [];
  } catch {
    return [];
  }
}
