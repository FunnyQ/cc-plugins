#!/usr/bin/env bun
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, rmdirSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

type Options = { repo: string; slug: string };
type RefOptions = Options & { ref: string };
type OpOptions = RefOptions & { op: string };
type Location = { path: string; base: string };
export type LandResult = {
  status: "clean" | "conflict" | "leak";
  drift: boolean;
  files: string[];
  paths: string[];
  fingerprint: string;
  previous: string;
};
type UnlandResult = { restored: string[] };
type RebaseResult = Location & { conflicted: string[] };
type OpResult = LandResult | UnlandResult | RebaseResult;
type Entry = Location & {
  previous?: string;
  landed?: string;
  ops?: Record<string, OpResult>;
};
type State = Record<string, Entry>;

class ArgumentError extends Error {}

function gitFailure(root: string, args: string[], stderr: string): Error {
  return new Error(`git -C ${root} ${args.join(" ")}\n${stderr}`);
}

function gitRaw(
  root: string,
  args: string[],
  options: { env?: Record<string, string>; stdin?: Uint8Array } = {},
) {
  return Bun.spawnSync(["git", "-C", root, ...args], {
    stdin: options.stdin,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
}

function git(
  root: string,
  args: string[],
  env?: Record<string, string>,
): string {
  const result = gitRaw(root, args, { env });
  if (result.exitCode !== 0) throw gitFailure(root, args, result.stderr.toString());
  return result.stdout.toString();
}

function validateRef(ref: string): void {
  if (!/^[a-z][a-z0-9-]*\/\d{2}$/.test(ref)) {
    throw new ArgumentError(`Invalid ref: ${ref}; expected <bucket>/<NN>`);
  }
}

function rootOf(options: Options): string {
  if (!options.repo || !isAbsolute(options.repo)) {
    throw new ArgumentError("--repo must be an absolute main-tree root");
  }
  if (!options.slug || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.slug)) {
    throw new ArgumentError("--slug must be a single directory name");
  }
  const repo = resolve(options.repo);
  return join(dirname(repo), `.${basename(repo)}-autopilot`, options.slug);
}

// A bucket may contain "-" but never "/", and NN never contains "-", so the last "-" is the separator.
const dirNameOf = (ref: string) => ref.replace("/", "-");
const refOfDir = (dir: string) => dir.replace(/-([^-]+)$/, "/$1");

function pathOf(options: RefOptions): string {
  validateRef(options.ref);
  return join(rootOf(options), dirNameOf(options.ref));
}

function readState(root: string): State {
  const file = join(root, "state.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function writeState(root: string, state: State): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function operation(options: OpOptions) {
  const path = pathOf(options);
  if (!options.op) throw new ArgumentError("--op is required");
  const root = rootOf(options);
  const state = readState(root);
  const entry = state[options.ref];
  if (!entry) throw new ArgumentError(`No worktree state for ${options.ref}`);
  const cached = entry.ops && Object.hasOwn(entry.ops, options.op)
    ? entry.ops[options.op] : undefined;
  return { path, root, state, entry, cached };
}

function record<T extends OpResult>(options: OpOptions, state: State, result: T): T {
  const entry = state[options.ref];
  // Defining an own property also permits op IDs such as "__proto__".
  entry.ops = { ...entry.ops, [options.op]: result };
  writeState(rootOf(options), state);
  return result;
}

function snapshot(root: string, slug: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "autopilot-snapshot-"));
  const index = join(scratch, "index");
  try {
    // Seed from this checkout's index so linked worktrees use their own staged files.
    const real = git(root, [
      "rev-parse", "--path-format=absolute", "--git-path", "index",
    ]).trim();
    if (existsSync(real)) {
      const times = statSync(real);
      copyFileSync(real, index);
      // A newer index timestamp would hide same-size racy-clean edits from Git.
      utimesSync(index, times.atime, times.mtime);
    }
    const env = { GIT_INDEX_FILE: index };
    git(root, ["add", "-A"], env);
    git(root, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", `docs/${slug}`], env);
    return git(root, ["write-tree"], env).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Only land, rebase, and create need a commit; fingerprints stay commit-free.
function commitOf(root: string, tree: string, slug: string): string {
  return git(root, ["commit-tree", tree, "-p", "HEAD", "-m", `autopilot snapshot ${slug}`]).trim();
}

function changedPaths(repo: string, from: string, to: string): string[] {
  return git(repo, ["diff", "--name-only", "--no-renames", "-z", from, to, "--"])
    .split("\0").filter(Boolean);
}

function merge(repo: string, base: string, ours: string, theirs: string) {
  const args = ["merge-tree", "--write-tree", "--name-only", "-z", `--merge-base=${base}`, ours, theirs];
  const result = gitRaw(repo, args);
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw gitFailure(repo, args, result.stderr.toString());
  }
  const [tree, ...fields] = result.stdout.toString().split("\0");
  if (!/^[a-f0-9]{40,64}$/.test(tree)) {
    throw gitFailure(repo, args, result.stderr.toString());
  }
  const conflicted: string[] = [];
  if (result.exitCode === 1) {
    for (const field of fields) {
      if (!field) break;
      conflicted.push(field);
    }
  }
  return { tree, conflicted, conflict: result.exitCode === 1 };
}

function applyDiff(repo: string, from: string, to: string): void {
  // Pin what user config could change: diff.noprefix, color.ui, apply.whitespace=fix.
  const diffArgs = [
    "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color",
    "--src-prefix=a/", "--dst-prefix=b/", from, to, "--",
  ];
  // Git text patches can contain non-UTF-8 bytes; decoding them would corrupt files.
  const patch = gitRaw(repo, diffArgs);
  if (patch.exitCode !== 0) throw gitFailure(repo, diffArgs, patch.stderr.toString());
  // Git rejects an empty patch, while a no-change land or unland is successful.
  if (!patch.stdout.length) return;
  const args = ["apply", "--binary", "--whitespace=nowarn"];
  const result = gitRaw(repo, args, { stdin: patch.stdout });
  if (result.exitCode !== 0) throw gitFailure(repo, args, result.stderr.toString());
}

function isDirectory(path: string): boolean {
  return existsSync(path) && lstatSync(path).isDirectory();
}

function seedIgnored(repo: string, path: string, slug: string): void {
  const excluded = `docs/${slug}`;
  function copy(relative: string): void {
    relative = relative.replace(/\/$/, "");
    if (relative === excluded || relative.startsWith(`${excluded}/`)) return;
    const source = join(repo, relative);
    // An ignored ancestor (for example docs/) may contain the excluded plan.
    if (excluded.startsWith(`${relative}/`)) {
      for (const child of readdirSync(source)) copy(`${relative}/${child}`);
      return;
    }
    const destination = join(path, relative);
    mkdirSync(dirname(destination), { recursive: true });
    const cloned = Bun.spawnSync(["cp", "-c", "-R", source, destination], { stdout: "pipe", stderr: "pipe", env: process.env });
    if (cloned.exitCode !== 0) {
      const fallback = isDirectory(source) && isDirectory(destination) ? `${source}/.` : source;
      Bun.spawnSync(["cp", "-R", fallback, destination], { stdout: "pipe", stderr: "pipe", env: process.env });
    }
  }
  let paths: string[];
  try {
    paths = git(repo, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
      .split("\0").filter(Boolean);
  } catch {
    return;
  }
  for (const relative of paths) {
    try { copy(relative); } catch { /* Ignored dependencies are best-effort seeds. */ }
  }
}

function registeredPaths(repo: string): Set<string> {
  return new Set(git(repo, ["worktree", "list", "--porcelain", "-z"])
    .split("\0").filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length)));
}

function removePath(repo: string, path: string, registered: Set<string>): boolean {
  if (registered.has(path)) {
    git(repo, ["worktree", "remove", "--force", path]);
    return true;
  }
  if (existsSync(path)) {
    // A prior interrupted cleanup can leave an unregistered directory under our root.
    rmSync(path, { recursive: true, force: true });
    return true;
  }
  return false;
}

export function create(options: RefOptions): Location {
  const path = pathOf(options);
  const root = rootOf(options);
  const state = readState(root);
  const registered = registeredPaths(options.repo);
  if (state[options.ref] || existsSync(path) || registered.has(path)) {
    removePath(options.repo, path, registered);
    git(options.repo, ["worktree", "prune"]);
    delete state[options.ref];
    writeState(root, state);
  }
  const base = commitOf(options.repo, snapshot(options.repo, options.slug), options.slug);
  mkdirSync(root, { recursive: true });
  git(options.repo, ["worktree", "add", "--detach", path, base]);
  seedIgnored(options.repo, path, options.slug);
  state[options.ref] = { path, base };
  writeState(root, state);
  return { path, base };
}

export function land(options: OpOptions & { expect: string }): LandResult {
  if (!options.expect) throw new ArgumentError("--expect is required for land");
  const { path, state, entry, cached } = operation(options);
  if (cached) return cached as LandResult;
  const ours = snapshot(options.repo, options.slug);
  if (options.expect !== ours) {
    return record(options, state, {
      status: "leak", drift: false, files: [],
      paths: changedPaths(options.repo, options.expect, ours),
      fingerprint: ours, previous: options.expect,
    });
  }
  if (!isDirectory(path)) throw new ArgumentError(`Missing worktree: ${path}`);
  const theirs = commitOf(path, snapshot(path, options.slug), options.slug);
  const drift = git(options.repo, ["rev-parse", `${entry.base}^{tree}`]).trim() !== ours;
  const merged = merge(options.repo, entry.base, commitOf(options.repo, ours, options.slug), theirs);
  if (merged.conflict) {
    return record(options, state, {
      status: "conflict", drift, files: merged.conflicted, paths: [],
      fingerprint: ours, previous: ours,
    });
  }
  const files = changedPaths(options.repo, ours, merged.tree);
  applyDiff(options.repo, ours, merged.tree);
  entry.previous = ours;
  entry.landed = merged.tree;
  return record(options, state, {
    status: "clean", drift, files, paths: [],
    fingerprint: merged.tree, previous: ours,
  });
}

export function unland(options: OpOptions): UnlandResult {
  const { state, entry, cached } = operation(options);
  if (cached) return cached as UnlandResult;
  if (!entry.previous || !entry.landed) {
    throw new ArgumentError(`No clean land to undo for ${options.ref}`);
  }
  const restored = changedPaths(options.repo, entry.landed, entry.previous);
  applyDiff(options.repo, entry.landed, entry.previous);
  delete entry.previous;
  delete entry.landed;
  return record(options, state, { restored });
}

export function rebase(options: OpOptions): RebaseResult {
  const { path, state, entry, cached } = operation(options);
  if (cached) return cached as RebaseResult;
  if (!isDirectory(path)) throw new ArgumentError(`Missing worktree: ${path}`);
  const ours = commitOf(options.repo, snapshot(options.repo, options.slug), options.slug);
  const theirs = commitOf(path, snapshot(path, options.slug), options.slug);
  const merged = merge(options.repo, entry.base, ours, theirs);
  git(path, ["reset", "--soft", ours]);
  git(path, ["read-tree", "-u", "--reset", merged.tree]);
  entry.base = ours;
  return record(options, state, { path, base: ours, conflicted: merged.conflicted });
}

export function fingerprint(options: Options & { expect?: string }): { fingerprint: string; paths: string[] } {
  rootOf(options);
  const tree = snapshot(options.repo, options.slug);
  return { fingerprint: tree, paths: options.expect ? changedPaths(options.repo, options.expect, tree) : [] };
}

export function show(options: RefOptions): { path: string; base: string | null; exists: boolean } {
  const path = pathOf(options);
  const entry = readState(rootOf(options))[options.ref];
  return { path, base: entry?.base ?? null, exists: isDirectory(path) };
}

export function remove(options: RefOptions): { removed: boolean } {
  const path = pathOf(options);
  const root = rootOf(options);
  const state = readState(root);
  const removed = removePath(options.repo, path, registeredPaths(options.repo));
  const hadState = Object.hasOwn(state, options.ref);
  if (hadState) {
    delete state[options.ref];
    writeState(root, state);
  }
  return { removed: removed || hadState };
}

export function sweep(options: Options & { keep?: string[]; keepAll?: boolean }): {
  removed: string[]; kept: { ref: string; path: string }[];
} {
  const root = rootOf(options);
  if (options.keepAll && options.keep !== undefined) throw new ArgumentError("--keep and --keep-all are mutually exclusive");
  for (const ref of options.keep ?? []) validateRef(ref);
  const directories = existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  const paths = new Map(directories.map((dir) => [refOfDir(dir), join(root, dir)]));
  const sorted = () => [...paths].sort(([a], [b]) => a.localeCompare(b));
  if (options.keepAll) {
    return { removed: [], kept: sorted().map(([ref, path]) => ({ ref, path })) };
  }
  const state = readState(root);
  const registered = registeredPaths(options.repo);
  for (const ref of Object.keys(state)) paths.set(ref, pathOf({ ...options, ref }));
  const keep = new Set(options.keep);
  const removed: string[] = [];
  const kept: { ref: string; path: string }[] = [];
  for (const [ref, path] of sorted()) {
    if (keep.has(ref)) {
      if (isDirectory(path)) kept.push({ ref, path });
      continue;
    }
    const didRemove = removePath(options.repo, path, registered);
    if (didRemove || Object.hasOwn(state, ref)) removed.push(ref);
    delete state[ref];
  }
  git(options.repo, ["worktree", "prune"]);
  if (existsSync(root)) {
    if (kept.length === 0) {
      rmSync(join(root, "state.json"), { force: true });
      rmdirSync(root);
    } else {
      writeState(root, state);
    }
  }
  return { removed, kept };
}

function main(): void {
  try {
    const [command, ...args] = process.argv.slice(2);
    const commands = ["create", "land", "unland", "rebase", "fingerprint", "show", "remove", "sweep"];
    if (!commands.includes(command)) throw new ArgumentError(`Unknown subcommand: ${command ?? "(missing)"}`);
    const flags: Record<string, string> = {};
    const positional: string[] = [];
    const allowed = new Set(["--repo", "--slug"]);
    if (["land", "unland", "rebase"].includes(command)) allowed.add("--op");
    if (["land", "fingerprint"].includes(command)) allowed.add("--expect");
    if (command === "sweep") { allowed.add("--keep"); allowed.add("--keep-all"); }
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!arg.startsWith("--")) { positional.push(arg); continue; }
      if (!allowed.has(arg) || Object.hasOwn(flags, arg)) throw new ArgumentError(`Invalid option: ${arg}`);
      if (arg === "--keep-all") { flags[arg] = "true"; continue; }
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new ArgumentError(`Missing value for ${arg}`);
      flags[arg] = value;
    }
    const needsRef = !["fingerprint", "sweep"].includes(command);
    if (positional.length !== (needsRef ? 1 : 0)) throw new ArgumentError(`Invalid arguments for ${command}`);
    const options = { repo: flags["--repo"], slug: flags["--slug"] };
    rootOf(options);
    const refOptions = { ...options, ref: positional[0] };
    const opOptions = { ...refOptions, op: flags["--op"] };
    let result: unknown;
    switch (command) {
      case "create": result = create(refOptions); break;
      case "land": result = land({ ...opOptions, expect: flags["--expect"] }); break;
      case "unland": result = unland(opOptions); break;
      case "rebase": result = rebase(opOptions); break;
      case "fingerprint": result = fingerprint({ ...options, expect: flags["--expect"] }); break;
      case "show": result = show(refOptions); break;
      case "remove": result = remove(refOptions); break;
      case "sweep": result = sweep({ ...options, keep: flags["--keep"]?.split(","), keepAll: flags["--keep-all"] === "true" }); break;
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof ArgumentError ? 2 : 1);
  }
}

if (import.meta.main) main();
