/**
 * log-root — where a project's `.cockpit/` decision trail lives.
 *
 * The storage anchor is the *repo*, not the current working directory. An agent
 * that cd'd into `frontend/` to run tests would otherwise start a second trail
 * there, silently splitting one repo's decision history across several
 * `.cockpit/` dirs (and several sidebar "projects").
 *
 *   1. an already-existing `.cockpit/` between cwd and the git root — nearest wins
 *   2. the git root
 *   3. cwd (not a git repo)
 *
 * Rule 1 is the escape hatch: a hand-made `packages/x/.cockpit` keeps its own
 * trail. It is bounded by the git root and never walks above it — `~/.cockpit`
 * is a real directory (the pre-XDG cockpit home, see cockpit-home.ts) and an
 * unbounded walk-up would collapse every repo under $HOME into one trail.
 *
 * This is the *storage* root only. Session lookup must keep using the raw cwd:
 * find-session.ts resolves sessions BY cwd (Claude encodes it into the
 * transcript dir, Codex matches `threads.cwd`, OpenCode matches
 * `session.directory`), so a session started in a subdir would not be found.
 */
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export type LogRootDeps = {
  /** Injectable for tests; defaults to the real `git rev-parse`. */
  gitRoot?: (cwd: string) => string | null;
};

/** The git top level containing `cwd`, or null when `cwd` is not in a repo. */
export function gitRootOf(cwd: string): string | null {
  try {
    const res = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    if (res.status !== 0) return null;
    const top = (res.stdout ?? "").trim();
    return top || null;
  } catch {
    // git missing / not executable — treat as "not a repo".
    return null;
  }
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

/**
 * Map a requested project path onto the registered project that owns it.
 *
 * Daemon readers only serve projects the registry already knows. A deep link
 * carries the live session's raw cwd, which may sit under the registered root,
 * so an exact-match check alone would 404 the panel. Purely lexical — it never
 * touches the filesystem — and it only ever resolves *downward*, so an unknown
 * ancestor can never unlock a registered project.
 */
export function resolveKnownProject(
  requested: string,
  known: Iterable<string>,
): string | null {
  if (!requested) return null;
  const target = resolve(requested);
  let best: string | null = null;
  for (const candidate of known) {
    if (!candidate) continue;
    const root = resolve(candidate);
    if (root !== target && !isInside(root, target)) continue;
    if (!best || root.length > best.length) best = root;
  }
  return best;
}

/** The directory whose `.cockpit/` holds this project's decision trail. */
export function logRoot(cwd: string, deps: LogRootDeps = {}): string {
  const resolveGitRoot = deps.gitRoot ?? gitRootOf;
  // `git rev-parse --show-toplevel` reports a realpath, so normalize cwd too or
  // the two never compare equal under a symlinked tmpdir (/tmp on macOS).
  const start = realpathOr(cwd);
  const root = resolveGitRoot(start);

  // Not a repo: no walk-up at all. Only cwd's own trail applies.
  if (!root) return start;

  const top = realpathOr(root);
  // The walk-up only makes sense along the path from cwd down-to-up to the
  // root. If cwd isn't under the reported root (a stale/renamed checkout, or an
  // injected resolver), walking cwd's own branch could adopt a `.cockpit` that
  // lives outside the repo entirely — exactly what the bound exists to prevent.
  if (start !== top && !isInside(top, start)) return top;

  let dir = start;
  for (;;) {
    if (isDir(join(dir, ".cockpit"))) return dir;
    if (dir === top) return top;
    const parent = dirname(dir);
    if (parent === dir) return top; // hit "/" without meeting the root
    dir = parent;
  }
}
