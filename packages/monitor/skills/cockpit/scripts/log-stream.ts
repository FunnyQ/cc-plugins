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
import { isAbsolute, relative, resolve } from "node:path";
import { readRegistry } from "./registry";
import {
  createTailStream,
  jsonError,
  splitCompleteLines,
  type ResolveResult,
} from "./sse-tailer";

const SESSION_RE = /^[0-9a-f-]{36}$/;

function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Resolve + confine the log path for a (project, session) pair. Returns the
// absolute log path, or null if the request fails validation. The session regex
// already blocks "/" and ".." so it can't escape the logs dir; we additionally
// realpath-confine (defends against a symlinked logs dir) and prefer a matching
// registry entry over a blindly-trusted query param.
export function resolveLogPath(
  project: string,
  session: string,
): string | null {
  if (!project || !SESSION_RE.test(session)) return null;

  const entry = readRegistry().find(
    (e) => e.sessionId === session && e.project === project,
  );

  const logsDir = resolve(project, ".cockpit", "logs");
  const logPath = entry?.logPath
    ? resolve(entry.logPath)
    : resolve(logsDir, `${session}.jsonl`);

  // lexical confinement
  if (!isInside(logsDir, logPath)) return null;

  // realpath confinement when the target (or its dir) exists
  try {
    if (existsSync(logPath)) {
      const realLogs = realpathSync(logsDir);
      const realFile = realpathSync(logPath);
      if (!isInside(realLogs, realFile)) return null;
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
