/**
 * project-registry.ts — read-only lookup over herdr-workbench's project
 * registry, plus a zoxide frecency fallback, for `tell`'s "no live agent
 * matched" path.
 *
 * This does not share code with herdr-workbench (a separate Rust binary) —
 * only the registry file's path and schema, and the recency/temp-path rules
 * workbench's picker already proved out. Nothing here ever writes the
 * registry; `last_used_at` upkeep stays workbench's job.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type ProjectEntry = {
  name: string;
  sources?: string[];
  aliases?: string[];
  hidden?: boolean;
  last_used_at?: number;
};

type ProjectRegistry = {
  version: number;
  projects: Record<string, ProjectEntry>;
};

export type ProjectCandidate = {
  path: string;
  name: string;
  aliases: string[];
  lastUsedAt?: number;
};

export const REGISTRY_PATH =
  process.env.HERDR_PROJECT_REGISTRY ??
  join(homedir(), ".local/state/herdr-projects/registry.json");

/** Reads the registry file into candidates. Any failure — missing file, bad
 *  JSON, an unsupported version, a hidden entry — degrades to an empty list
 *  rather than throwing, so a broken or absent registry never breaks `tell`. */
export async function readRegistry(
  path: string = REGISTRY_PATH,
): Promise<ProjectCandidate[]> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return [];
  }
  let parsed: ProjectRegistry;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed?.version !== 1 || !parsed.projects) return [];

  return Object.entries(parsed.projects)
    .filter(([, entry]) => entry.hidden !== true)
    .map(([path, entry]) => ({
      path,
      name: entry.name,
      aliases: entry.aliases ?? [],
      lastUsedAt: entry.last_used_at,
    }));
}

/** Four temp-directory shapes a registry sweep should never surface, mirroring
 *  herdr-workbench's src/registry/project.rs filter. */
export function isTempPath(path: string): boolean {
  return (
    /^\/tmp(\/|$)/.test(path) ||
    /^\/private\/tmp(\/|$)/.test(path) ||
    /^\/var\/folders\/[^/]+\/[^/]+\/T(\/|$)/.test(path) ||
    /^\/private\/var\/folders\/[^/]+\/[^/]+\/T(\/|$)/.test(path)
  );
}

/** Same fragment rule as matchAgents: split on `/`, every part must appear
 *  case-insensitively somewhere in the name, an alias, or the path. */
export function matchProjects(
  candidates: ProjectCandidate[],
  fragment: string,
): ProjectCandidate[] {
  const query = fragment.trim().toLowerCase();
  if (!query) return [];

  const parts = query.split("/").filter(Boolean);
  return candidates.filter((c) => {
    if (isTempPath(c.path)) return false;
    const haystack = [c.name, ...c.aliases, c.path].map((v) => v.toLowerCase());
    return parts.every((part) => haystack.some((v) => v.includes(part)));
  });
}

/** Most-recently-used first; entries with no timestamp sink below every
 *  stamped one; ties break alphabetically by name. Mirrors workbench's
 *  compare_projects exactly (src/flows/picker.rs). */
export function compareProjects(
  a: ProjectCandidate,
  b: ProjectCandidate,
): number {
  if (a.lastUsedAt !== undefined && b.lastUsedAt !== undefined) {
    return b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name);
  }
  if (a.lastUsedAt !== undefined) return -1;
  if (b.lastUsedAt !== undefined) return 1;
  return a.name.localeCompare(b.name);
}

/** Below this length zoxide's frecency ranking is too noisy to trust — mirrors
 *  workbench's DISCOVERY_MINIMUM_QUERY. */
const DISCOVERY_MINIMUM_QUERY = 2;

export type ZoxideRunner = (
  args: string[],
) => Promise<{ stdout: string; code: number }>;

const defaultZoxideRunner: ZoxideRunner = async (args) => {
  try {
    const proc = Bun.spawn(["zoxide", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { stdout, code };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { stdout: "", code: 127 };
    throw error;
  }
};

/** The single highest-frecency path zoxide knows for `query`, or null when
 *  zoxide is missing, has no match, or the match no longer resolves to a real
 *  directory. Never throws — a missing/broken zoxide is a silent no-op, same
 *  as workbench's query_zoxide. */
export async function queryZoxide(
  query: string,
  run: ZoxideRunner = defaultZoxideRunner,
): Promise<string | null> {
  if (query.trim().length < DISCOVERY_MINIMUM_QUERY) return null;
  let result: { stdout: string; code: number };
  try {
    result = await run(["query", "--", query]);
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  const path = result.stdout.trim().split("\n")[0]?.trim();
  if (!path || isTempPath(path)) return null;
  try {
    const stat = await Bun.file(path).stat();
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return path;
}
