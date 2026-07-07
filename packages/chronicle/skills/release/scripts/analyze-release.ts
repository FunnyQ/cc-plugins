#!/usr/bin/env bun
/**
 * Chronicle release analyzer.
 *
 * Pure core (unit-tested): version math, pattern-aware version read/write, repo
 * shape detection (interview defaults), and `.chronicle/release.json` config I/O.
 * Thin git/fs shell on top feeds the seer agent and applies/verifies bumps.
 *
 * Usage:
 *   bun analyze-release.ts                       # detect + emit JSON for the interview/gate
 *   bun analyze-release.ts --verify 0.5.0        # check version files sit at 0.5.0
 *   bun analyze-release.ts --apply 0.5.0         # rewrite version files to 0.5.0
 *   bun analyze-release.ts --verify 0.5.0 --component chronicle
 */

import { $, Glob } from "bun";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VersionFileKind = "json" | "toml" | "text";

/** A version source: either a known `kind` or a custom capture-group `pattern`. */
export type VersionFileSpec =
  { path: string; kind: VersionFileKind } | { path: string; pattern: string };

export type ComponentSpec = {
  name: string;
  path: string;
  versionFiles: VersionFileSpec[];
};

export type ReleaseConfig = {
  mode: "whole-repo" | "per-component";
  /** Tag template. Supports `{version}` and (per-component) `{component}`. */
  tag: string;
  changelog: string;
  branches: { develop: string; main: string };
  /** whole-repo bump targets. Empty = changelog + tag only. */
  versionFiles: VersionFileSpec[];
  /** per-component bump targets, one entry per releasable unit. */
  components?: ComponentSpec[];
};

export type ManifestFact = {
  path: string;
  version: string | null;
  kind: VersionFileKind;
};

export type ShapeFacts = {
  manifests: ManifestFact[];
  tags: string[];
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

/**
 * Find the top-level JSON `"version"`. `readVersionFromContent` reads it via
 * JSON.parse (structurally top-level), so the runesmith must target the same field —
 * a naive first-match would rewrite a nested `"version"` that happens to appear
 * earlier. Pick the match with the shallowest line indentation (top-level members
 * of a pretty-printed manifest sit at the outermost indent); fall back to the first
 * match for minified single-line JSON.
 */
function topLevelJsonVersion(content: string): RegExpMatchArray | null {
  let best: { m: RegExpMatchArray; indent: number } | null = null;
  for (const m of content.matchAll(/"version"\s*:\s*"([^"]+)"/g)) {
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

function specOf(m: ManifestFact): VersionFileSpec {
  return { path: m.path, kind: m.kind };
}

const DEFAULT_BRANCHES = { develop: "develop", main: "main" } as const;

export function detectShape(facts: ShapeFacts): ReleaseConfig {
  const scoped = scopedTagComponents(facts.tags);

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
          versionFiles: manifests.map(specOf),
        }),
      );
      return {
        mode: "per-component",
        tag: "{component}-v{version}",
        changelog: "CHANGELOG.md",
        branches: { ...DEFAULT_BRANCHES },
        versionFiles: [],
        components,
      };
    }
  }

  // whole-repo: only auto-fill a version file when exactly one manifest exists;
  // anything ambiguous is left for the interview to resolve.
  const versionFiles =
    facts.manifests.length === 1 ? [specOf(facts.manifests[0])] : [];
  return {
    mode: "whole-repo",
    tag: "v{version}",
    changelog: "CHANGELOG.md",
    branches: { ...DEFAULT_BRANCHES },
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
    typeof raw.branches?.develop !== "string" ||
    typeof raw.branches?.main !== "string"
  ) {
    bad(`branches must name develop and main`);
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

async function git(
  strings: TemplateStringsArray,
  ...v: unknown[]
): Promise<string> {
  try {
    return (await $({ raw: strings }, ...v).quiet()).stdout.toString().trim();
  } catch {
    return "";
  }
}

async function repoRoot(): Promise<string> {
  return (await git`git rev-parse --show-toplevel`) || process.cwd();
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
      byPath.set(rel, { path: rel, version, kind });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function allTags(): Promise<string[]> {
  const out = await git`git tag`;
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * The literal prefix a tag has before its version, derived from `config.tag` (the
 * source of truth) — not hard-coded. `v{version}` → `v`; `{component}-v{version}`
 * with component `chronicle` → `chronicle-v`; a custom `release-{version}` →
 * `release-`. This keeps last-tag lookup consistent with how the hammerbearer cuts the
 * tag, even when the interview set a non-default template.
 */
export function tagPrefix(config: ReleaseConfig, component?: string): string {
  const filled = component
    ? config.tag.replaceAll("{component}", component)
    : config.tag;
  const i = filled.indexOf("{version}");
  return i >= 0 ? filled.slice(0, i) : filled;
}

function lastTagFor(
  tags: string[],
  config: ReleaseConfig,
  component?: string,
): { tag: string; version: string } | null {
  const prefix = tagPrefix(config, component);
  const matching = tags
    .filter((t) => t.startsWith(prefix))
    .map((t) => t.slice(prefix.length))
    .filter((v) => parseSemver(v))
    .sort((a, b) => cmpSemver(a, b));
  const top = matching.at(-1);
  return top ? { tag: `${prefix}${top}`, version: top } : null;
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

async function apply(
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

async function sh(cmd: string): Promise<string> {
  try {
    return (await $({ raw: [cmd] }).quiet()).stdout.toString().trim();
  } catch {
    return "";
  }
}

async function commitCountSince(
  ref: string | null,
  pathScope?: string,
): Promise<number> {
  const range = ref ? `${ref}..HEAD` : "HEAD";
  const scope = pathScope ? ` -- ${pathScope}` : "";
  const out = await sh(`git rev-list --count ${range}${scope}`);
  return Number(out) || 0;
}

export type ComponentFact = {
  name: string;
  path: string;
  lastTag: string | null;
  current: string | null;
  bumps: { patch: string; minor: string; major: string } | null;
  commitCount: number;
};

async function perComponentFacts(
  config: ReleaseConfig,
  tags: string[],
): Promise<ComponentFact[]> {
  const components = config.components ?? [];
  return Promise.all(
    components.map(async (c) => {
      const last = lastTagFor(tags, config, c.name);
      const current = last?.version ?? null;
      return {
        name: c.name,
        path: c.path,
        lastTag: last?.tag ?? null,
        current,
        bumps: current ? computeBumps(current) : null,
        commitCount: await commitCountSince(last?.tag ?? null, c.path),
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
  const tags = await allTags();
  const manifests = await discoverManifests(root);
  const suggested = detectShape({ manifests, tags });
  const effective = config ?? suggested;
  const branch = await git`git branch --show-current`;

  const component =
    values.component ??
    (effective.mode === "per-component"
      ? effective.components?.[0]?.name
      : undefined);
  const last = lastTagFor(tags, effective, component);
  const current = last?.version ?? null;

  // per-component mode: enumerate each unit with its own version + change count
  // so the main agent's version gate can offer "which component + which bump".
  const components =
    effective.mode === "per-component"
      ? await perComponentFacts(effective, tags)
      : null;

  const out = {
    root,
    branch,
    component,
    hasConfig: Boolean(config),
    config,
    suggested,
    tags,
    lastTag: last?.tag ?? null,
    current,
    bumps: current ? computeBumps(current) : null,
    components,
  };

  const dir = "/tmp/chronicle/release";
  await mkdir(dir, { recursive: true });
  const outputPath = resolve(dir, `${Date.now()}.json`);
  await writeFile(outputPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ outputPath, ...out }, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("analyze-release error:", err.message);
    process.exit(2);
  });
}
