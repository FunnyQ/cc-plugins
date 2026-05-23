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
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readRegistry } from "./registry";

const SESSION_RE = /^[0-9a-f-]{36}$/;
const WATCH_DEBOUNCE_MS = 80;
const HEARTBEAT_MS = 25_000;

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

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

function splitCompleteLines(text: string): {
  complete: string;
  partial: string;
} {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return { complete: "", partial: text };
  return {
    complete: text.slice(0, lastNewline),
    partial: text.slice(lastNewline + 1),
  };
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

  const logPath = resolveLogPath(project, session);
  if (!logPath) return jsonError("invalid project/session");

  let watcher: FSWatcher | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let offset = 0;
  let partial = "";

  function cleanup(): void {
    closed = true;
    watcher?.close();
    watcher = null;
    if (heartbeat) clearInterval(heartbeat);
    if (debounce) clearTimeout(debounce);
  }

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          cleanup();
        }
      };

      enqueue(": connected\n\n");

      // backlog — read the whole (small) log once
      if (existsSync(logPath)) {
        try {
          const size = statSync(logPath).size;
          const buf = Buffer.allocUnsafe(size);
          const fd = openSync(logPath, "r");
          try {
            readSync(fd, buf, 0, size, 0);
          } finally {
            closeSync(fd);
          }
          const text = buf.toString("utf-8");
          const split = splitCompleteLines(text);
          emitLines(enqueue, split.complete);
          partial = split.partial;
          offset = size;
        } catch {
          // file vanished between resolve and read — backlog stays empty
        }
      }

      enqueue("event: backlog-done\ndata: {}\n\n");

      const readTail = () => {
        if (closed || !existsSync(logPath)) return;
        try {
          const size = statSync(logPath).size;
          if (size < offset) {
            offset = 0;
            partial = "";
          }
          if (size <= offset) return;
          const length = size - offset;
          const buf = Buffer.allocUnsafe(length);
          const fd = openSync(logPath, "r");
          try {
            readSync(fd, buf, 0, length, offset);
          } finally {
            closeSync(fd);
          }
          offset = size;
          const split = splitCompleteLines(partial + buf.toString("utf-8"));
          partial = split.partial;
          emitLines(enqueue, split.complete);
        } catch {
          // mid-write/rotating — next watch tick retries
        }
      };

      try {
        watcher = watch(logPath, () => {
          if (debounce) return;
          debounce = setTimeout(() => {
            debounce = null;
            readTail();
          }, WATCH_DEBOUNCE_MS);
        });
      } catch {
        // file not yet present; the goal record is written at start, so this is
        // rare. The client can re-open if needed.
      }

      heartbeat = setInterval(() => enqueue(": ping\n\n"), HEARTBEAT_MS);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
