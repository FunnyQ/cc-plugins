#!/usr/bin/env bun
/**
 * Chronicle release analyzer.
 *
 * Pure core (unit-tested): version math, pattern-aware version read/write, repo
 * shape detection (interview defaults), and `.chronicle/release.json` config I/O.
 * Thin git/fs shell on top feeds the skill's version gate and applies bumps.
 *
 * Usage:
 *   bun analyze-release.ts                       # detect + emit JSON for the interview/gate
 *   bun analyze-release.ts --verify 0.5.0        # check version files sit at 0.5.0
 *   bun analyze-release.ts --apply 0.5.0         # rewrite version files to 0.5.0
 *   bun analyze-release.ts --verify 0.5.0 --component chronicle
 */

import { $, Glob } from "bun";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { writeTempPayload } from "../../../shared/scripts/temp-payload";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VersionFileKind = "json" | "toml" | "text";

/** How the repo finishes a release: a develop→main merge, or a commit on main. */
export type Workflow = "git-flow" | "github-flow";

/** A version source: either a known `kind` or a custom capture-group `pattern`. */
export type VersionFileSpec =
  | { path: string; kind: VersionFileKind }
  | { path: string; pattern: string };

/**
 * A committed build output that carries its version from the manifest at build
 * time — a compiled binary, a bundled script. Nothing can rewrite it, so the
 * release checks it instead of bumping it. It is the one release mistake git
 * cannot see: the manifest moves, the artifact keeps the old version, and the
 * tag ships the mismatch.
 */
export type ArtifactSpec = {
  /** Repo-relative path. Staged with the release commit. */
  path: string;
  /** How to ask it for its version. Default: `./<path> --version`. */
  command?: string;
  /** How to rebuild it. Absent means the release stops and asks for a build. */
  build?: string;
};

export type ComponentSpec = {
  name: string;
  path: string;
  versionFiles: VersionFileSpec[];
  artifacts?: ArtifactSpec[];
};

export type ReleaseConfig = {
  mode: "whole-repo" | "per-component";
  /**
   * Repo workflow. Absent means `git-flow` — configs written before this field
   * existed keep the exact meaning they had.
   */
  workflow?: Workflow;
  /** Tag template. Supports `{version}` and (per-component) `{component}`. */
  tag: string;
  changelog: string;
  /** `develop` is required for git-flow and unused for github-flow. */
  branches: { main: string; develop?: string };
  /** whole-repo bump targets. Empty = changelog + tag only. */
  versionFiles: VersionFileSpec[];
  /** whole-repo committed build outputs. Per-component ones live on the component. */
  artifacts?: ArtifactSpec[];
  /** per-component bump targets, one entry per releasable unit. */
  components?: ComponentSpec[];
};

export function artifactCommand(spec: ArtifactSpec): string {
  return spec.command ?? `./${spec.path} --version`;
}

/**
 * Whether a `--version` output carries exactly this version.
 *
 * Bounded on both sides by digit-or-dot, so `0.8.0` never matches inside
 * `0.8.01` or `10.8.0` — a substring test would call a wrong build current,
 * which is the failure this whole check exists to catch.
 */
export function versionInOutput(output: string, version: string): boolean {
  const want = escapeRegex(normalizeVersion(version));
  return new RegExp(`(?<![\\d.])${want}(?![\\d.])`).test(output);
}

/** A missing `workflow` is git-flow — never silently a new default. */
export function effectiveWorkflow(
  config: Pick<ReleaseConfig, "workflow">,
): Workflow {
  return config.workflow ?? "git-flow";
}

export type ManifestFact = {
  path: string;
  version: string | null;
  kind: VersionFileKind;
  /**
   * Extra version files that ride with this manifest — today only the Cargo.lock
   * block for its crate. They are never discovered on their own: a lock is not a
   * manifest, and counting it as one would break the "exactly one manifest"
   * whole-repo heuristic and leave a workspace-root lock outside every component.
   */
  companions?: VersionFileSpec[];
};

export type ShapeFacts = {
  manifests: ManifestFact[];
  tags: string[];
  /** Local + remote branch names. Absent = unknown, which stays git-flow. */
  branches?: string[];
  /** Fallback long-lived branch when neither main nor master exists. */
  currentBranch?: string;
};

// ---------------------------------------------------------------------------
// Version math
// ---------------------------------------------------------------------------

export function normalizeVersion(v: string): string {
  return v.replace(/^v/, "");
}

function parseSemver(
  v: string,
): { major: number; minor: number; patch: number } | null {
  const core = normalizeVersion(v.trim()).split(/[-+]/)[0];
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(core);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

// Bumps a stable version from a (possibly prerelease/build) base: the metadata is
// dropped, not carried forward — Chronicle cuts stable releases, not prereleases.
export function computeBumps(
  current: string,
): { patch: string; minor: string; major: string } | null {
  const s = parseSemver(current);
  if (!s) return null;
  return {
    patch: `${s.major}.${s.minor}.${s.patch + 1}`,
    minor: `${s.major}.${s.minor + 1}.0`,
    major: `${s.major + 1}.0.0`,
  };
}

// ---------------------------------------------------------------------------
// Version file read / write (kind- or pattern-based)
// ---------------------------------------------------------------------------

function tomlRe() {
  return /^(version\s*=\s*["'])[^"']+(["'])/m;
}

/** Replace only `match[1]` (the version substring) in place. */
function spliceGroup(
  content: string,
  m: RegExpMatchArray,
  value: string,
): string {
  const gStart = m.index! + m[0].indexOf(m[1]);
  return content.slice(0, gStart) + value + content.slice(gStart + m[1].length);
}

/** Find the top-level JSON `"version"` key without reformatting the file. */
function topLevelJsonVersion(content: string): RegExpMatchArray | null {
  const depthAt = new Array<number>(content.length);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    depthAt[i] = depth;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
    }
  }

  let best: { m: RegExpMatchArray; indent: number } | null = null;
  for (const m of content.matchAll(/"version"\s*:\s*"([^"]+)"/g)) {
    if (depthAt[m.index!] !== 1) continue;
    const indent = m.index! - (content.lastIndexOf("\n", m.index!) + 1);
    if (!best || indent < best.indent) best = { m, indent };
  }
  return best?.m ?? null;
}

export function readVersionFromContent(
  content: string,
  spec: VersionFileSpec,
): string | null {
  if ("pattern" in spec) {
    const m = new RegExp(spec.pattern).exec(content);
    return m?.[1] ?? null;
  }
  switch (spec.kind) {
    case "json": {
      try {
        const json = JSON.parse(content);
        const v = json.version ?? json.plugins?.[0]?.version;
        if (typeof v === "string") return v;
      } catch {
        /* fall through to regex */
      }
      return /"version"\s*:\s*"([^"]+)"/.exec(content)?.[1] ?? null;
    }
    case "toml": {
      return /^version\s*=\s*["']([^"']+)["']/m.exec(content)?.[1] ?? null;
    }
    case "text": {
      return content.trim() || null;
    }
  }
}

export function applyVersionToContent(
  content: string,
  spec: VersionFileSpec,
  newVersion: string,
): string {
  if ("pattern" in spec) {
    const m = new RegExp(spec.pattern).exec(content);
    if (!m || m[1] === undefined) {
      throw new Error(`pattern did not match a version in ${spec.path}`);
    }
    return spliceGroup(content, m, newVersion);
  }
  switch (spec.kind) {
    case "json": {
      const m = topLevelJsonVersion(content);
      if (!m) {
        throw new Error(`no "version" in ${spec.path}`);
      }
      return spliceGroup(content, m, newVersion);
    }
    case "toml": {
      if (!tomlRe().test(content)) {
        throw new Error(`no version field in ${spec.path}`);
      }
      return content.replace(tomlRe(), `$1${newVersion}$2`);
    }
    case "text": {
      return newVersion + (content.endsWith("\n") ? "\n" : "");
    }
  }
}

// ---------------------------------------------------------------------------
// Cargo.lock (a version file no `kind` can describe)
// ---------------------------------------------------------------------------

/** The `[package]` name of a Cargo.toml — never a `[workspace]` or dependency key. */
export function cargoPackageName(toml: string): string | null {
  const header = /^\[package\]\s*$/m.exec(toml);
  if (!header) return null; // a virtual workspace manifest carries no version either
  const rest = toml.slice(header.index + header[0].length);
  const next = /^\[/m.exec(rest);
  const body = next ? rest.slice(0, next.index) : rest;
  return /^name\s*=\s*["']([^"']+)["']/m.exec(body)?.[1] ?? null;
}

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * A Cargo.lock spec for one crate, or null when the lock holds no block for it.
 *
 * `kind: "toml"` must never point at a lock: it has one `version = "..."` per
 * package — hundreds of them — and would move whichever sorts first. So the spec
 * is a pattern anchored on the preceding `name = "<crate>"`, which is the only
 * thing that identifies the block. Returning null rather than an unmatched
 * pattern keeps a spec we cannot prove out of the committed config.
 */
export function cargoLockSpec(
  path: string,
  crate: string,
  lock: string,
): VersionFileSpec | null {
  const pattern = `name = "${escapeRegex(crate)}"\\nversion = "([^"]+)"`;
  return new RegExp(pattern).test(lock) ? { path, pattern } : null;
}

// ---------------------------------------------------------------------------
// Shape detection (produces interview defaults, not gospel)
// ---------------------------------------------------------------------------

export function scopedTagComponents(tags: string[]): Set<string> {
  const set = new Set<string>();
  for (const t of tags) {
    const m = /^(.+)-v\d+\.\d+\.\d+/.exec(t);
    if (m) set.add(m[1]);
  }
  return set;
}

function componentOf(path: string, scoped: Set<string>): string | null {
  for (const seg of path.split("/")) {
    if (scoped.has(seg)) return seg;
  }
  return null;
}

function componentPath(manifestPath: string, name: string): string {
  const segs = manifestPath.split("/");
  const idx = segs.indexOf(name);
  return idx >= 0 ? segs.slice(0, idx + 1).join("/") : name;
}

function specsOf(m: ManifestFact): VersionFileSpec[] {
  return [{ path: m.path, kind: m.kind }, ...(m.companions ?? [])];
}

const DEFAULT_BRANCHES = { develop: "develop", main: "main" } as const;

function hasBranch(branches: string[], name: string): boolean {
  return branches.some((b) => b === name || b === `origin/${name}`);
}

/**
 * Workflow + branch names read off the repo's actual branches. github-flow is only
 * ever *detected* — an unknown branch list (older callers, a non-git dir) keeps the
 * historical git-flow default, so nothing that works today changes shape.
 */
export function detectWorkflow(facts: ShapeFacts): {
  workflow: Workflow;
  branches: { main: string; develop?: string };
} {
  const branches = facts.branches;
  if (!branches || branches.length === 0) {
    return { workflow: "git-flow", branches: { ...DEFAULT_BRANCHES } };
  }
  const main =
    ["main", "master"].find((n) => hasBranch(branches, n)) ??
    facts.currentBranch ??
    DEFAULT_BRANCHES.main;
  return hasBranch(branches, "develop")
    ? { workflow: "git-flow", branches: { develop: "develop", main } }
    : { workflow: "github-flow", branches: { main } };
}

export type WorkflowDrift = {
  configured: Workflow;
  missingBranch: string;
  suggest: Workflow;
};

/**
 * A committed git-flow config whose develop branch no longer exists — the repo
 * moved to GitHub Flow after recording its shape. Reported, never acted on: a
 * missing `workflow` field keeps meaning git-flow, so the fix is an explicit config
 * edit the user approves, not a silent re-detection.
 */
export function detectWorkflowDrift(
  config: ReleaseConfig,
  branches: string[] | undefined,
): WorkflowDrift | null {
  if (!branches || branches.length === 0) return null;
  if (effectiveWorkflow(config) !== "git-flow") return null;
  const develop = config.branches.develop;
  if (!develop || hasBranch(branches, develop)) return null;
  return {
    configured: "git-flow",
    missingBranch: develop,
    suggest: "github-flow",
  };
}

export type VersionFileDrift = {
  /** null for a whole-repo config. */
  component: string | null;
  /** The manifest already in the config whose companion is missing. */
  manifest: string;
  missing: VersionFileSpec;
};

/**
 * A committed config that bumps a manifest but not the companion file that
 * carries the same version — today, a `Cargo.toml` without its `Cargo.lock`.
 *
 * Detection runs once, at the first-run interview, so a config written before
 * companions existed never learns about them. Reported, never applied: the
 * config is the source of truth, and re-shaping it silently is exactly what the
 * workflow drift rule already refuses.
 *
 * Only a manifest the config *already* lists can drift. A repo that deliberately
 * releases something else is never nagged about a crate it never named.
 */
export function detectVersionFileDrift(
  config: ReleaseConfig,
  manifests: ManifestFact[],
): VersionFileDrift[] {
  const units =
    config.mode === "per-component"
      ? (config.components ?? []).map((c) => ({
          component: c.name as string | null,
          files: c.versionFiles,
        }))
      : [{ component: null, files: config.versionFiles }];

  const out: VersionFileDrift[] = [];
  for (const unit of units) {
    const paths = new Set(unit.files.map((f) => f.path));
    for (const m of manifests) {
      if (!paths.has(m.path)) continue;
      for (const companion of m.companions ?? []) {
        if (paths.has(companion.path)) continue;
        out.push({
          component: unit.component,
          manifest: m.path,
          missing: companion,
        });
      }
    }
  }
  return out;
}

export function detectShape(facts: ShapeFacts): ReleaseConfig {
  const scoped = scopedTagComponents(facts.tags);
  const { workflow, branches } = detectWorkflow(facts);

  if (scoped.size > 0) {
    const byComponent = new Map<string, ManifestFact[]>();
    for (const m of facts.manifests) {
      const name = componentOf(m.path, scoped);
      if (!name) continue;
      const list = byComponent.get(name) ?? [];
      list.push(m);
      byComponent.set(name, list);
    }
    if (byComponent.size > 0) {
      const components: ComponentSpec[] = [...byComponent.entries()].map(
        ([name, manifests]) => ({
          name,
          path: componentPath(manifests[0].path, name),
          versionFiles: manifests.flatMap(specsOf),
        }),
      );
      return {
        mode: "per-component",
        workflow,
        tag: "{component}-v{version}",
        changelog: "CHANGELOG.md",
        branches,
        versionFiles: [],
        components,
      };
    }
  }

  // whole-repo: only auto-fill a version file when exactly one manifest exists;
  // anything ambiguous is left for the interview to resolve.
  const versionFiles =
    facts.manifests.length === 1 ? specsOf(facts.manifests[0]) : [];
  return {
    mode: "whole-repo",
    workflow,
    tag: "v{version}",
    changelog: "CHANGELOG.md",
    branches,
    versionFiles,
  };
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

export function parseConfig(text: string): ReleaseConfig {
  const raw = JSON.parse(text);
  const bad = (why: string): never => {
    throw new Error(`invalid release config: ${why}`);
  };
  if (raw?.mode !== "whole-repo" && raw?.mode !== "per-component") {
    bad(`unknown mode ${raw?.mode}`);
  }
  if (typeof raw.tag !== "string" || !raw.tag.includes("{version}")) {
    bad(`tag must be a template containing {version}`);
  }
  if (typeof raw.changelog !== "string") bad(`changelog must be a string`);
  if (
    raw.workflow !== undefined &&
    raw.workflow !== "git-flow" &&
    raw.workflow !== "github-flow"
  ) {
    bad(`unknown workflow ${raw.workflow}`);
  }
  if (typeof raw.branches?.main !== "string") bad(`branches must name main`);
  // A config predating `workflow` is git-flow, so it still has to name develop.
  if (
    effectiveWorkflow(raw as ReleaseConfig) === "git-flow" &&
    typeof raw.branches?.develop !== "string"
  ) {
    bad(`git-flow branches must name develop`);
  }
  const checkArtifacts = (list: unknown, where: string) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) bad(`${where} artifacts must be an array`);
    for (const a of list as Array<{ path?: unknown }>) {
      if (typeof a?.path !== "string") {
        bad(`${where} artifacts entries need a string path`);
      }
    }
  };
  checkArtifacts(raw.artifacts, "top-level");
  for (const c of (raw.components ?? []) as ComponentSpec[]) {
    checkArtifacts(c.artifacts, `component ${c.name}`);
  }
  if (raw.mode === "per-component") {
    if (!Array.isArray(raw.components) || raw.components.length === 0) {
      bad(`per-component config needs a non-empty components[]`);
    }
    if (!raw.tag.includes("{component}")) {
      bad(`per-component tag must include {component}`);
    }
  } else if (!Array.isArray(raw.versionFiles)) {
    bad(`whole-repo config needs a versionFiles[] (may be empty)`);
  }
  return raw as ReleaseConfig;
}

export function serializeConfig(config: ReleaseConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}

const CONFIG_REL = ".chronicle/release.json";

export function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_REL);
}

export async function loadConfig(
  repoRoot: string,
): Promise<ReleaseConfig | null> {
  let text: string;
  try {
    text = await readFile(configPath(repoRoot), "utf-8");
  } catch {
    return null; // absent → genuine first run
  }
  // A file that exists but is corrupt must fail loudly, not masquerade as a first
  // run (which would re-interview and overwrite it).
  return parseConfig(text);
}

export async function saveConfig(
  repoRoot: string,
  config: ReleaseConfig,
): Promise<string> {
  const path = configPath(repoRoot);
  await mkdir(join(repoRoot, ".chronicle"), { recursive: true });
  await writeFile(path, serializeConfig(config), "utf-8");
  return path;
}

// ---------------------------------------------------------------------------
// Git / fs shell (not unit-tested; drives the agents)
// ---------------------------------------------------------------------------

const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|vendor|\.cache)(\/|$)/;

const MANIFEST_GLOBS: Array<{ glob: string; kind: VersionFileKind }> = [
  { glob: "**/.claude-plugin/plugin.json", kind: "json" },
  { glob: "**/.codex-plugin/plugin.json", kind: "json" },
  { glob: "package.json", kind: "json" },
  { glob: "*/package.json", kind: "json" },
  { glob: "Cargo.toml", kind: "toml" },
  { glob: "*/Cargo.toml", kind: "toml" },
  { glob: "pyproject.toml", kind: "toml" },
  { glob: "*/pyproject.toml", kind: "toml" },
  { glob: "VERSION", kind: "text" },
  { glob: "*/VERSION", kind: "text" },
];

export async function git(
  strings: TemplateStringsArray,
  ...v: unknown[]
): Promise<string> {
  try {
    return (await $({ raw: strings }, ...v).quiet()).stdout.toString().trim();
  } catch {
    return "";
  }
}

export async function repoRoot(): Promise<string> {
  return (await git`git rev-parse --show-toplevel`) || process.cwd();
}

/**
 * The Cargo.lock that governs a manifest: the crate's own dir first, then the
 * workspace root. The lock carries the crate's version too, so leaving it out
 * tags a tree whose manifest and lockfile disagree.
 */
async function cargoLockCompanion(
  root: string,
  manifestRel: string,
  toml: string,
): Promise<VersionFileSpec | null> {
  const crate = cargoPackageName(toml);
  if (!crate) return null;
  const dir = dirname(manifestRel);
  const candidates =
    dir === "." ? ["Cargo.lock"] : [join(dir, "Cargo.lock"), "Cargo.lock"];
  for (const rel of candidates) {
    const lock = await readFile(resolve(root, rel), "utf-8").catch(() => "");
    const spec = lock ? cargoLockSpec(rel, crate, lock) : null;
    if (spec) return spec;
  }
  return null;
}

async function discoverManifests(root: string): Promise<ManifestFact[]> {
  const byPath = new Map<string, ManifestFact>();
  for (const { glob, kind } of MANIFEST_GLOBS) {
    const g = new Glob(glob);
    for await (const rel of g.scan({ cwd: root, onlyFiles: true, dot: true })) {
      if (SKIP_DIR.test(rel) || byPath.has(rel)) continue;
      const content = await readFile(resolve(root, rel), "utf-8").catch(
        () => "",
      );
      const version = content
        ? readVersionFromContent(content, { path: rel, kind })
        : null;
      const lock =
        content && rel.endsWith("Cargo.toml")
          ? await cargoLockCompanion(root, rel, content)
          : null;
      byPath.set(rel, {
        path: rel,
        version,
        kind,
        ...(lock ? { companions: [lock] } : {}),
      });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function allTags(): Promise<string[]> {
  const out = await git`git tag`;
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * Branch names out of plain `git branch --all` output — the current-branch marker,
 * `remotes/` prefix, detached-HEAD line, and `origin/HEAD -> …` alias all dropped.
 * Plain output rather than `--format=%(refname:short)`: Bun's shell reads `(` as a
 * subshell and the command never runs.
 */
export function parseBranchNames(out: string): string[] {
  return out
    .split("\n")
    .map((line) => line.replace(/^[*+]?\s*/, "").trim())
    .filter((line) => line && !line.startsWith("(") && !line.includes(" -> "))
    .map((line) => line.replace(/^remotes\//, ""));
}

/** Local + remote branch names, or undefined when git can't tell us. */
async function allBranches(): Promise<string[] | undefined> {
  const out = await git`git branch --all --no-color`;
  if (!out) return undefined;
  const names = parseBranchNames(out);
  return names.length > 0 ? names : undefined;
}

function tagRegex(config: ReleaseConfig, component?: string): RegExp {
  const semver = "(?<version>\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)";
  let pattern = "";
  let last = 0;
  for (const m of config.tag.matchAll(/\{version\}|\{component\}/g)) {
    pattern += escapeRegex(config.tag.slice(last, m.index!));
    pattern +=
      m[0] === "{version}"
        ? semver
        : escapeRegex(component ?? "[unknown-component]");
    last = m.index! + m[0].length;
  }
  pattern += escapeRegex(config.tag.slice(last));
  return new RegExp(`^${pattern}$`);
}

export function lastTagFor(
  tags: string[],
  config: ReleaseConfig,
  component?: string,
): { tag: string; version: string } | null {
  const re = tagRegex(config, component);
  const matching = tags
    .flatMap((tag) => {
      const m = re.exec(tag);
      const version = m?.groups?.version;
      return version && parseSemver(version) ? [{ tag, version }] : [];
    })
    .sort((a, b) => cmpSemver(a.version, b.version));
  const top = matching.at(-1);
  return top ?? null;
}

function cmpSemver(a: string, b: string): number {
  const pa = parseSemver(a)!;
  const pb = parseSemver(b)!;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

function filesFor(
  config: ReleaseConfig,
  component?: string,
): VersionFileSpec[] {
  if (config.mode === "per-component") {
    const c = config.components?.find((x) => x.name === component);
    if (!c) {
      throw new Error(
        `unknown component "${component}" in release config — ` +
          `known: ${(config.components ?? []).map((x) => x.name).join(", ")}`,
      );
    }
    return c.versionFiles;
  }
  return config.versionFiles;
}

async function verify(
  root: string,
  expected: string,
  files: VersionFileSpec[],
): Promise<{
  expected: string;
  allMatch: boolean;
  noVersionFiles: boolean;
  files: Array<{ path: string; current: string | null; matches: boolean }>;
}> {
  const want = normalizeVersion(expected);
  const results = await Promise.all(
    files.map(async (spec) => {
      const content = await readFile(resolve(root, spec.path), "utf-8").catch(
        () => "",
      );
      const current = content ? readVersionFromContent(content, spec) : null;
      return {
        path: spec.path,
        current,
        matches: current ? normalizeVersion(current) === want : false,
      };
    }),
  );
  return {
    expected: want,
    // An empty file list is a legitimate changelog-+-tag-only release (a repo with
    // no bump target), so it verifies vacuously — NOT a mismatch. A per-component
    // config with a missing component can't reach here: filesFor() throws first.
    allMatch: results.every((f) => f.matches),
    noVersionFiles: results.length === 0,
    files: results,
  };
}

export async function apply(
  root: string,
  version: string,
  files: VersionFileSpec[],
): Promise<string[]> {
  const want = normalizeVersion(version);
  const changed: string[] = [];
  for (const spec of files) {
    const full = resolve(root, spec.path);
    const content = await readFile(full, "utf-8");
    const next = applyVersionToContent(content, spec, want);
    if (next !== content) {
      await writeFile(full, next, "utf-8");
      changed.push(spec.path);
    }
  }
  return changed;
}

async function commitCountSince(
  ref: string | null,
  pathScope?: string,
): Promise<number | null> {
  const range = ref ? `${ref}..HEAD` : "HEAD";
  try {
    const out = pathScope
      ? await $`git rev-list --count ${range} -- ${pathScope}`.quiet()
      : await $`git rev-list --count ${range}`.quiet();
    const count = Number(out.stdout.toString().trim());
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

/**
 * The one version every version file agrees on, or null when they disagree, when
 * one is unreadable, or when the unit has no version file at all.
 *
 * Null collapses all three cases into "no prepared state detected", and the unit
 * then goes through the ordinary bump gate. Disagreeing files are not reported as
 * their own condition. A unit configured with no version file at all — the
 * changelog-and-tag-only shape — can therefore never read as prepared.
 */
export function agreedVersion(
  files: Array<{ current: string | null }>,
): string | null {
  if (files.length === 0) return null;
  const versions = files.map((f) =>
    f.current ? normalizeVersion(f.current) : null,
  );
  if (versions.some((v) => v === null)) return null;
  return versions.every((v) => v === versions[0]) ? versions[0] : null;
}

/**
 * Whether CHANGELOG.md already heads an entry for this version. Matches the
 * heading shape the annalist writes: `## [<component> <version>]` per-component,
 * `## [<version>]` whole-repo.
 */
export function hasChangelogEntry(
  changelog: string,
  version: string,
  component?: string,
): boolean {
  const want = escapeRegex(normalizeVersion(version));
  const label = component
    ? `${escapeRegex(component)}\\s+v?${want}`
    : `v?${want}`;
  return new RegExp(`^##\\s*\\[\\s*${label}\\s*\\]`, "m").test(changelog);
}

export type ComponentFact = {
  name: string;
  path: string;
  lastTag: string | null;
  current: string | null;
  bumps: { patch: string; minor: string; major: string } | null;
  commitCount: number | null;
  fileVersion: string | null;
  changelogEntry: boolean;
};

/** Reads one repo-root-relative path, returning "" when it cannot be read. */
type ContentReader = (path: string) => Promise<string>;

const workingTreeReader =
  (root: string): ContentReader =>
  (path) =>
    readFile(resolve(root, path), "utf-8").catch(() => "");

/** The version the unit's own files currently carry, independent of any tag. */
async function fileVersionFor(
  files: VersionFileSpec[],
  read: ContentReader,
): Promise<string | null> {
  const got = await Promise.all(
    files.map(async (spec) => {
      const content = await read(spec.path);
      return {
        current: content ? readVersionFromContent(content, spec) : null,
      };
    }),
  );
  return agreedVersion(got);
}

async function perComponentFacts(
  root: string,
  config: ReleaseConfig,
  tags: string[],
  changelog: string,
): Promise<ComponentFact[]> {
  const components = config.components ?? [];
  return Promise.all(
    components.map(async (c) => {
      const last = lastTagFor(tags, config, c.name);
      const current = last?.version ?? null;
      const fileVersion = await fileVersionFor(
        c.versionFiles,
        workingTreeReader(root),
      );
      const changelogEntry = fileVersion
        ? hasChangelogEntry(changelog, fileVersion, c.name)
        : false;
      return {
        name: c.name,
        path: c.path,
        lastTag: last?.tag ?? null,
        current,
        bumps: current ? computeBumps(current) : null,
        commitCount: await commitCountSince(last?.tag ?? null, c.path),
        fileVersion,
        changelogEntry,
      };
    }),
  );
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      verify: { type: "string" },
      apply: { type: "string" },
      component: { type: "string" },
      "save-config": { type: "string" },
    },
  });

  const root = await repoRoot();
  const config = await loadConfig(root);

  if (values["save-config"]) {
    const text = await readFile(values["save-config"], "utf-8");
    const path = await saveConfig(root, parseConfig(text));
    console.log(JSON.stringify({ saved: path }));
    return;
  }

  if (values.verify || values.apply) {
    if (!config) {
      console.error(
        "no .chronicle/release.json — run the release interview first",
      );
      process.exit(2);
    }
    const files = filesFor(config, values.component);

    if (values.apply) {
      const changed = await apply(root, values.apply, files);
      console.log(JSON.stringify({ applied: values.apply, changed }));
      return;
    }

    const result = await verify(root, values.verify!, files);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.allMatch ? 0 : 1);
  }

  // default: detection facts for the interview / version gate
  const [tags, manifests, branch, branches] = await Promise.all([
    allTags(),
    discoverManifests(root),
    git`git branch --show-current`,
    allBranches(),
  ]);
  const suggested = detectShape({
    manifests,
    tags,
    branches,
    currentBranch: branch || undefined,
  });
  const effective = config ?? suggested;

  const component =
    values.component ??
    (effective.mode === "per-component"
      ? effective.components?.[0]?.name
      : undefined);
  const last = lastTagFor(tags, effective, component);
  const current = last?.version ?? null;

  const changelog = await readFile(
    resolve(root, effective.changelog),
    "utf-8",
  ).catch(() => "");

  // per-component mode: enumerate each unit with its own version + change count
  // so the main agent's version gate can offer "which component + which bump".
  const components =
    effective.mode === "per-component"
      ? await perComponentFacts(root, effective, tags, changelog)
      : null;

  // A repo that bumps on the feature branch merges with the version files and the
  // CHANGELOG entry already in place. Report that, so the gate can tag instead of
  // bumping a second time. Whole-repo only — per-component reports it per unit.
  const wholeRepoFileVersion =
    effective.mode === "per-component"
      ? null
      : await fileVersionFor(effective.versionFiles, workingTreeReader(root));
  const wholeRepoChangelogEntry = wholeRepoFileVersion
    ? hasChangelogEntry(changelog, wholeRepoFileVersion)
    : false;

  const out = {
    root,
    branch,
    component,
    workflow: effectiveWorkflow(effective),
    workflowDrift: config ? detectWorkflowDrift(config, branches) : null,
    versionFileDrift: config ? detectVersionFileDrift(config, manifests) : [],
    hasConfig: Boolean(config),
    config,
    suggested,
    tags,
    lastTag: last?.tag ?? null,
    current,
    bumps: current ? computeBumps(current) : null,
    fileVersion: wholeRepoFileVersion,
    changelogEntry: wholeRepoChangelogEntry,
    components,
  };

  const outputPath = await writeTempPayload("release", "analysis", out);
  console.log(JSON.stringify({ outputPath, ...out }, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("analyze-release error:", err.message);
    process.exit(2);
  });
}
