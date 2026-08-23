// cockpit decision-log SSE — GET /api/log/stream?project=<abs>&session=<id>
// streams a session's decision JSONL: a backlog of existing records, a
// backlog-done marker, then live appends tailed via fs.watch. Same mechanism as
// the transcript stream, but the watched root is the project's .cockpit/logs/.
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
import { readRegistry } from "./registry";
import { isPathInside } from "../../shared/scripts/path-inside";
import {
  createTailStream,
  jsonError,
  splitCompleteLines,
  type ResolveResult,
} from "./sse-tailer";

const SESSION_RE = /^[0-9a-f-]{36}$/;

// Same path, or one contains the other. Segment-wise (via relative()), so
// "/repo" and "/repo-other" are unrelated.
function arePathsRelated(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return x === y || isPathInside(x, y) || isPathInside(y, x);
}

// Resolve + confine the log path for a (project, session) pair. Returns the
// absolute log path, or null if the request fails validation. The session regex
// already blocks "/" and ".." so it can't escape the logs dir; we additionally
// realpath-confine (defends against a symlinked logs dir).
//
// The registry entry — not the query param — is authoritative for a tracked
// session: callers deep-link with the live session's raw cwd, which can be a
// subpackage of the repo root the trail actually lives at (and legacy entries
// point the other way round). Matching the two would 400 both cases. Each
// candidate is still confined to ITS OWN project's logs dir.
export function resolveLogPath(
  project: string,
  session: string,
): string | null {
  if (!project || !SESSION_RE.test(session)) return null;

  const tracked = readRegistry().find((e) => e.sessionId === session);
  // The entry wins only when the requested project is on the same branch as the
  // one that owns it (either direction: a subpackage deep link pointing at the
  // repo root, or a root request for a legacy subpackage entry). An unrelated
  // project must not be able to stream a session just by knowing its id.
  const entry =
    tracked && arePathsRelated(tracked.project, project) ? tracked : undefined;
  if (tracked && !entry) return null;

  const root = entry?.logPath ? entry.project : project;
  const logsDir = resolve(root, ".cockpit", "logs");
  const logPath = entry?.logPath
    ? resolve(entry.logPath)
    : resolve(logsDir, `${session}.jsonl`);

  // lexical confinement
  if (!isPathInside(logsDir, logPath)) return null;

  // realpath confinement when the target (or its dir) exists
  try {
    if (existsSync(logPath)) {
      const realLogs = realpathSync(logsDir);
      const realFile = realpathSync(logPath);
      if (!isPathInside(realLogs, realFile)) return null;
    }
  } catch {
    return null;
  }
  return logPath;
}

// Emit each valid JSON record in `text` as its own SSE data frame; skip blank
// and malformed lines so one bad line never kills the stream.
function emitLines(enqueue: (chunk: string) => void, text: string): void {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    enqueue(`data: ${JSON.stringify(rec)}\n\n`);
  }
}

export function handleLogStream(req: Request): Response {
  const url = new URL(req.url);
  const project = url.searchParams.get("project") ?? "";
  const session = url.searchParams.get("session") ?? "";

  // resolveLogPath returns the computed path even before the file exists; the
  // tailer waits for it to appear. Re-run per poll so a symlinked logs dir is
  // re-confined once the target materialises.
  const resolve = (): ResolveResult => {
    const logPath = resolveLogPath(project, session);
    return logPath
      ? { kind: "ready", path: logPath }
      : { kind: "fail", message: "invalid project/session", status: 400 };
  };

  return createTailStream({
    resolve,
    readBacklog: (path, size) => {
      // read the whole (small) log once
      const buf = Buffer.allocUnsafe(size);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buf, 0, size, 0);
      } finally {
        closeSync(fd);
      }
      return splitCompleteLines(buf.toString("utf-8"));
    },
    emit: emitLines,
  });
}
