#!/usr/bin/env bun

// Installer for the OpenCode harness: links this checkout's skills, plugin module,
// chronicle agents and monitor commands into ~/.config/opencode/, and raises
// subagent_depth so chronicle's orchestrators can spawn their children.
//
// Rules a reader must know before changing anything here:
//
// 1. SCOPE. Nothing outside <home>/.config/opencode/ is ever written. Not
//    ~/.claude/settings.json, not ~/.codex/. Claude Code and Codex must behave
//    identically after an install.
// 2. NEVER OVERWRITE FOREIGN. A real file, or a symlink pointing outside this
//    repo, at a target path is a human's decision. --apply reports it, skips it,
//    and exits non-zero. It never unlinks, never overwrites, never backs up.
// 3. --unlink LEAVES subagent_depth ALONE. The value may predate this install and
//    another tool may rely on it; lowering it would break a working setup. The
//    leftover is announced so it is not a surprise.
// 4. RAISE-ONLY DEPTH. A value above 2 belongs to the user. An unparseable config
//    is never rewritten — the manual edit is printed instead.
// 5. SKILL-NAME COLLISIONS. OpenCode's skill root is flat, but skill names are only
//    unique per plugin: monitor and chronicle both ship a skill called `install`.
//    Installing both under `skills/install` would silently drop one, so colliding
//    names are installed plugin-prefixed (`monitor-install`, `chronicle-install`).
//    Any duplicate `installed` path that survives that is a bug, and buildTargets
//    throws rather than letting the last target win.
//
// Runtime facts this depends on (docs/opencode-compat/tasks/_context/runtime-facts.md):
// S7 and S6 RESOLVED — symlinked skill directories are discovered and resolve to
// their realpath, so symlinks (not copies) are the install model. S8 RESOLVED —
// realpath, so the plugin is a plain symlink with no generated shim. S14 is only
// PARTIALLY RESOLVED: the shipped default is 1, but whether OpenCode reads
// subagent_depth at startup or live is unverified, so the report says the restart
// requirement is unknown instead of guessing either way.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const REQUIRED_SUBAGENT_DEPTH = 2;

export type LinkState = "ok" | "missing" | "stale" | "broken" | "foreign";

export type DepthDecision = {
  action: "ok" | "write" | "unparsable";
  value: number;
  reason: string;
};

export type Target = {
  kind: "symlink" | "config";
  group: "skill" | "plugin" | "agent" | "command" | "config";
  name: string;
  source: string | null;
  installed: string;
};

export type PlanOperation = {
  target: Target;
  action: "create" | "replace" | "keep" | "skip" | "write";
  state: LinkState | DepthDecision["action"];
};

export type ApplyPlan = {
  operations: PlanOperation[];
  success: boolean;
};

export type SkillDir = { plugin: string; dir: string };

export type SkillEntry = SkillDir & { name: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function subdirectories(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function markdownFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -".md".length))
    .sort();
}

/** Every `packages/*\/skills/*` directory that carries a SKILL.md. The filter is the
 *  point: `packages/monitor/skills/shared` is imported by monitor's skills but is not
 *  one, and a bare glob would surface it as a phantom skill in OpenCode. */
export function findSkillDirs(repoRoot: string): SkillDir[] {
  const packagesRoot = join(repoRoot, "packages");
  const found: SkillDir[] = [];
  for (const plugin of subdirectories(packagesRoot)) {
    const skillsRoot = join(packagesRoot, plugin, "skills");
    if (!existsSync(skillsRoot)) continue;
    for (const dir of subdirectories(skillsRoot)) {
      if (existsSync(join(skillsRoot, dir, "SKILL.md")))
        found.push({ plugin, dir });
    }
  }
  return found;
}

/** Installed name per skill: the directory name, plugin-prefixed when two plugins
 *  ship the same one. Both sides of a collision are prefixed — leaving one bare
 *  would make which plugin "owns" the plain name arbitrary and order-dependent. */
export function resolveSkillNames(dirs: readonly SkillDir[]): SkillEntry[] {
  const seen = new Map<string, number>();
  for (const { dir } of dirs) seen.set(dir, (seen.get(dir) ?? 0) + 1);
  return dirs.map((entry) => ({
    ...entry,
    name:
      (seen.get(entry.dir) ?? 0) > 1
        ? `${entry.plugin}-${entry.dir}`
        : entry.dir,
  }));
}

export function buildTargets(repoRoot: string, home: string): Target[] {
  const configRoot = join(home, ".config", "opencode");
  const skills: Target[] = resolveSkillNames(findSkillDirs(repoRoot)).map(
    ({ plugin, dir, name }) => ({
      kind: "symlink",
      group: "skill",
      name,
      source: join(repoRoot, "packages", plugin, "skills", dir),
      installed: join(configRoot, "skills", name),
    }),
  );
  const agents: Target[] = markdownFiles(
    join(repoRoot, "opencode", "agents"),
  ).map((name) => ({
    kind: "symlink",
    group: "agent",
    name,
    source: join(repoRoot, "opencode", "agents", `${name}.md`),
    installed: join(configRoot, "agents", `${name}.md`),
  }));
  const commands: Target[] = markdownFiles(
    join(repoRoot, "opencode", "commands"),
  ).map((name) => ({
    kind: "symlink",
    group: "command",
    name,
    source: join(repoRoot, "opencode", "commands", `${name}.md`),
    installed: join(configRoot, "commands", `${name}.md`),
  }));

  const targets: Target[] = [
    ...skills,
    {
      kind: "symlink",
      group: "plugin",
      name: "q-lab.ts",
      source: join(repoRoot, "opencode", "plugin.ts"),
      installed: join(configRoot, "plugin", "q-lab.ts"),
    },
    ...agents,
    ...commands,
    {
      kind: "config",
      group: "config",
      name: "subagent_depth",
      source: null,
      installed: join(configRoot, "opencode.json"),
    },
  ];

  assertDistinctPaths(targets);
  return targets;
}

/** A shared `installed` path means one source silently never gets installed while
 *  the check still reports it green. Fail loudly instead. */
function assertDistinctPaths(targets: readonly Target[]): void {
  const owner = new Map<string, Target>();
  for (const target of targets) {
    const existing = owner.get(target.installed);
    if (existing) {
      throw new Error(
        `two targets claim ${target.installed}: ${existing.source ?? existing.name} and ${target.source ?? target.name}`,
      );
    }
    owner.set(target.installed, target);
  }
}

export function classifyLink(
  probe: { exists: boolean; isSymlink: boolean; resolved: string | null },
  expectedSource: string,
  repoRoot: string,
): LinkState {
  if (!probe.isSymlink) return probe.exists ? "foreign" : "missing";
  if (probe.resolved === null) return "broken";
  if (!probe.exists) return "broken";
  if (resolve(probe.resolved) === resolve(expectedSource)) return "ok";
  return isWithin(probe.resolved, repoRoot) ? "stale" : "foreign";
}

export function decideSubagentDepth(config: unknown): DepthDecision {
  if (!isPlainObject(config)) {
    return {
      action: "unparsable",
      value: REQUIRED_SUBAGENT_DEPTH,
      reason: "opencode.json is not a JSON object — leaving it untouched.",
    };
  }

  const current = config.subagent_depth;
  if (typeof current !== "number" || !Number.isFinite(current)) {
    return {
      action: "write",
      value: REQUIRED_SUBAGENT_DEPTH,
      reason: "subagent_depth is missing or invalid — write 2.",
    };
  }
  if (current < REQUIRED_SUBAGENT_DEPTH) {
    return {
      action: "write",
      value: REQUIRED_SUBAGENT_DEPTH,
      reason: `subagent_depth is ${current}, below the required depth.`,
    };
  }
  return {
    action: "ok",
    value: current,
    reason: `subagent_depth is already ${current}.`,
  };
}

function planActionFor(state: LinkState): PlanOperation["action"] {
  if (state === "missing") return "create";
  if (state === "stale" || state === "broken") return "replace";
  if (state === "ok") return "keep";
  return "skip"; // foreign — a human's file, never touched
}

export function buildApplyPlan(
  targets: Target[],
  linkStates: ReadonlyMap<string, LinkState>,
  depth: DepthDecision,
): ApplyPlan {
  const operations = targets.map((target): PlanOperation => {
    if (target.kind === "config") {
      const action =
        depth.action === "write"
          ? "write"
          : depth.action === "ok"
            ? "keep"
            : "skip";
      return { target, action, state: depth.action };
    }
    const state = linkStates.get(target.installed) ?? "missing";
    return { target, action: planActionFor(state), state };
  });
  return {
    operations,
    success: operations.every((operation) => operation.action !== "skip"),
  };
}

function probeLink(path: string): {
  exists: boolean;
  isSymlink: boolean;
  resolved: string | null;
} {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink())
      return { exists: true, isSymlink: false, resolved: null };
    const raw = readlinkSync(path);
    const resolvedTarget = resolve(dirname(path), raw);
    return {
      exists: existsSync(resolvedTarget),
      isSymlink: true,
      resolved: resolvedTarget,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, isSymlink: false, resolved: null };
    }
    throw error;
  }
}

function readConfig(path: string): { config: unknown; parseFailed: boolean } {
  if (!existsSync(path)) return { config: {}, parseFailed: false };
  try {
    if (!lstatSync(path).isFile()) return { config: null, parseFailed: true };
    return {
      config: JSON.parse(readFileSync(path, "utf8")),
      parseFailed: false,
    };
  } catch {
    return { config: null, parseFailed: true };
  }
}

function manualDepthHint(): void {
  console.log("Add this to ~/.config/opencode/opencode.json by hand:");
  console.log('  "subagent_depth": 2');
}

// S14 is only partially resolved: read timing (startup vs live) was never observed.
function depthRestartNote(): void {
  console.log(
    "note: whether OpenCode reads subagent_depth at startup or live is unverified — restart OpenCode if nested agents still stop early.",
  );
}

function legacyRelayWarning(home: string): void {
  const legacy = join(home, ".claude", "skills", "relay");
  if (lstatExists(legacy)) {
    console.warn(
      `WARNING legacy relay symlink present: ${legacy} — OpenCode scans ~/.claude/skills/ too, so remove it or you will see two skills named relay.`,
    );
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function targetLabel(target: Target): string {
  return `${target.group}:${target.name} ${target.installed}`;
}

function collectState(
  targets: Target[],
  repoRoot: string,
): {
  states: Map<string, LinkState>;
  config: Record<string, unknown> | null;
  depth: DepthDecision;
} {
  const states = new Map<string, LinkState>();
  for (const target of targets) {
    if (target.kind === "symlink") {
      states.set(
        target.installed,
        classifyLink(probeLink(target.installed), target.source!, repoRoot),
      );
    }
  }
  const configTarget = targets.find((target) => target.kind === "config")!;
  const loaded = readConfig(configTarget.installed);
  const depth = decideSubagentDepth(loaded.config);
  return {
    states,
    config: isPlainObject(loaded.config) ? loaded.config : null,
    depth: loaded.parseFailed ? { ...depth, action: "unparsable" } : depth,
  };
}

function runCheck(targets: Target[], repoRoot: string, home: string): number {
  const { states, depth } = collectState(targets, repoRoot);
  let success = true;
  for (const target of targets) {
    if (target.kind === "config") {
      const mark = depth.action === "ok" ? "✓" : "✗";
      console.log(`${mark} ${targetLabel(target)} (${depth.action})`);
      success &&= depth.action === "ok";
      if (depth.action === "unparsable") manualDepthHint();
      continue;
    }
    const state = states.get(target.installed)!;
    const mark = state === "ok" ? "✓" : state === "foreign" ? "○" : "✗";
    console.log(`${mark} ${targetLabel(target)} (${state})`);
    success &&= state === "ok";
  }
  legacyRelayWarning(home);
  return success ? 0 : 1;
}

function reportOperation(operation: PlanOperation): void {
  console.log(
    `${operation.action} ${targetLabel(operation.target)} (${operation.state})`,
  );
}

function runApply(
  targets: Target[],
  repoRoot: string,
  dryRun: boolean,
): number {
  const { states, config, depth } = collectState(targets, repoRoot);
  const plan = buildApplyPlan(targets, states, depth);
  for (const operation of plan.operations) reportOperation(operation);
  if (
    plan.operations.some(
      (operation) =>
        operation.action === "skip" && operation.state === "foreign",
    )
  ) {
    console.log(
      "skipped entries are real files or links outside this repo — remove them by hand, this installer never will.",
    );
  }

  if (!dryRun) {
    for (const operation of plan.operations) {
      const { target } = operation;
      if (operation.action === "create" || operation.action === "replace") {
        mkdirSync(dirname(target.installed), { recursive: true });
        if (operation.action === "replace") unlinkSync(target.installed);
        symlinkSync(
          target.source!,
          target.installed,
          target.group === "skill" ? "dir" : "file",
        );
      } else if (operation.action === "write") {
        mkdirSync(dirname(target.installed), { recursive: true });
        writeFileSync(
          target.installed,
          `${JSON.stringify({ ...config, subagent_depth: REQUIRED_SUBAGENT_DEPTH }, null, 2)}\n`,
        );
      }
    }
  }

  if (depth.action === "unparsable") manualDepthHint();
  if (depth.action === "write") depthRestartNote();
  return plan.success ? 0 : 1;
}

function runUnlink(targets: Target[], repoRoot: string): number {
  for (const target of targets) {
    if (target.kind === "config") {
      console.log(
        `keep ${targetLabel(target)} (subagent_depth is left in place)`,
      );
      continue;
    }
    const probe = probeLink(target.installed);
    if (
      probe.isSymlink &&
      probe.resolved !== null &&
      isWithin(probe.resolved, repoRoot)
    ) {
      unlinkSync(target.installed);
      console.log(`unlink ${targetLabel(target)}`);
    } else {
      console.log(
        `keep ${targetLabel(target)} (${classifyLink(probe, target.source!, repoRoot)})`,
      );
    }
  }
  return 0;
}

export function main(args: string[], repoRoot: string, home: string): number {
  const mode = args[0] ?? "--check";
  if (
    args.length > 1 ||
    !["--check", "--dry-run", "--apply", "--unlink"].includes(mode)
  ) {
    console.error(
      "Usage: bun opencode/install.ts [--check|--dry-run|--apply|--unlink]",
    );
    return 2;
  }
  const targets = buildTargets(repoRoot, home);
  if (mode === "--check") return runCheck(targets, repoRoot, home);
  if (mode === "--dry-run") return runApply(targets, repoRoot, true);
  if (mode === "--apply") return runApply(targets, repoRoot, false);
  return runUnlink(targets, repoRoot);
}

if (import.meta.path === Bun.main) {
  process.exitCode = main(
    process.argv.slice(2),
    resolve(import.meta.dir, ".."),
    homedir(),
  );
}
