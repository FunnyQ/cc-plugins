// Shared resilient SSE tailer for the cockpit decision-log and transcript
// streams. Both endpoints stream a JSONL file as Server-Sent Events: a backlog
// of existing lines, a `backlog-done` marker, then live appends.
//
// Resilience model (watch-first, poll-backed):
//   1. File appears later — a not-yet-present file is NOT a 404. The connection
//      stays open and re-resolves on an interval until the file shows up, then
//      emits the backlog and starts tailing. (A 404 would make EventSource fail
//      the connection permanently — no auto-reconnect — leaving the panel blank.)
//   2. watch() throws / never fires — fs.watch is the low-latency primary, but a
//      low-frequency poll runs alongside it as a safety net, so appends are still
//      delivered even when the watcher is unreliable or fails to attach.
//   3. File replaced / rotated (new inode) — we watch the parent directory too,
//      and readTail compares inode + size each pass: a new inode or a shrunk file
//      resets the byte cursor and re-binds the file watcher (which may be stuck on
//      the old inode).
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs";
import { dirname } from "node:path";
import { jsonResponse } from "./http";

const WATCH_DEBOUNCE_MS = 80;
const HEARTBEAT_MS = 25_000;
// Poll cadences are env-tunable and read per request: ops can trade latency for
// cost, and tests lower them to stay within their timeouts.
const resolvePollMs = () => Number(process.env.COCKPIT_RESOLVE_POLL_MS) || 500;
const tailPollMs = () => Number(process.env.COCKPIT_TAIL_POLL_MS) || 2_000;

export type WatchFn = (path: string, cb: () => void) => FSWatcher;

// What `resolve()` reports each time it's polled:
//   ready — a confined, ready-to-read file path
//   wait  — not present yet; keep the connection open and poll again
//   fail  — a hard error (bad params / confinement); HTTP-fail before the stream
//           opens, silently close after
export type ResolveResult =
  | { kind: "ready"; path: string }
  | { kind: "wait" }
  | { kind: "fail"; message: string; status: number };

export type TailSource = {
  // Re-evaluated until it yields a confined, existing file path.
  resolve: () => ResolveResult;
  // Read the backlog to emit on attach. The cursor then advances to `size`.
  readBacklog: (
    path: string,
    size: number,
  ) => {
    complete: string;
    partial: string;
  };
  // Provider-specific parse + filter of newly appended text into SSE frames.
  emit: (enqueue: (chunk: string) => void, completeText: string) => void;
  // Injectable for tests; defaults to node:fs watch. A throwing watch exercises
  // the poll-only fallback.
  watch?: WatchFn;
};

// Stream param-validation error: a 400 by default (bad request), distinct from
// the generic 500 in http.ts. Re-exported here so the stream handlers keep
// importing it from the tailer.
export function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export function splitCompleteLines(text: string): {
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

export function createTailStream(source: TailSource): Response {
  // First resolve: a hard failure (bad params / confinement) must surface as an
  // HTTP error before we commit to an SSE response. "wait" and "ready" both open
  // the stream — a not-yet-present file is no longer a 404.
  const first = source.resolve();
  if (first.kind === "fail") return jsonError(first.message, first.status);

  const watch = source.watch ?? fsWatch;

  let fileWatcher: FSWatcher | null = null;
  let dirWatcher: FSWatcher | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let resolvePoll: ReturnType<typeof setInterval> | null = null;
  let tailPoll: ReturnType<typeof setInterval> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let started = false;
  let filePath: string | null = null;
  let inode = -1;
  let offset = 0;
  let partial = "";

  function cleanup(): void {
    closed = true;
    fileWatcher?.close();
    fileWatcher = null;
    dirWatcher?.close();
    dirWatcher = null;
    if (heartbeat) clearInterval(heartbeat);
    if (resolvePoll) clearInterval(resolvePoll);
    if (tailPoll) clearInterval(tailPoll);
    if (debounce) clearTimeout(debounce);
    heartbeat = resolvePoll = tailPoll = null;
    debounce = null;
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

      function attachFileWatcher(): void {
        fileWatcher?.close();
        fileWatcher = null;
        if (!filePath) return;
        try {
          fileWatcher = watch(filePath, onFsEvent);
        } catch {
          // poll fallback covers it
        }
      }

      const readTail = () => {
        if (closed || !filePath || !existsSync(filePath)) return;
        try {
          const st = statSync(filePath);
          // Atomic replace / truncate: a new inode or a shrunk file means our
          // byte cursor is stale — restart from the top of the current file and
          // re-bind the watcher (the old one may be stuck on the old inode).
          if (st.ino !== inode || st.size < offset) {
            offset = 0;
            partial = "";
            if (st.ino !== inode) {
              inode = st.ino;
              attachFileWatcher();
            }
          }
          if (st.size <= offset) return;
          const length = st.size - offset;
          const buf = Buffer.allocUnsafe(length);
          const fd = openSync(filePath, "r");
          try {
            readSync(fd, buf, 0, length, offset);
          } finally {
            closeSync(fd);
          }
          offset = st.size;
          const split = splitCompleteLines(partial + buf.toString("utf-8"));
          partial = split.partial;
          source.emit(enqueue, split.complete);
        } catch {
          // mid-write / rotating — the next watch tick or poll retries
        }
      };

      function onFsEvent(): void {
        if (debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          readTail();
        }, WATCH_DEBOUNCE_MS);
      }

      const beginTailing = (path: string) => {
        if (started || closed) return;
        started = true;
        filePath = path;
        try {
          inode = statSync(path).ino;
        } catch {
          inode = -1;
        }

        // backlog
        try {
          const size = statSync(path).size;
          const { complete, partial: trailing } = source.readBacklog(
            path,
            size,
          );
          source.emit(enqueue, complete);
          partial = trailing;
          offset = size;
        } catch {
          // vanished between resolve and read — backlog stays empty
        }
        enqueue("event: backlog-done\ndata: {}\n\n");

        attachFileWatcher();
        // Parent-dir watch catches create/rename/atomic-replace that a file
        // watcher bound to the old inode would miss.
        try {
          dirWatcher = watch(dirname(path), onFsEvent);
        } catch {
          // poll fallback covers it
        }
        // Low-frequency safety net behind fs.watch.
        tailPoll = setInterval(readTail, tailPollMs());
      };

      // Returns true once resolution is settled (ready+tailing, or failed) so the
      // caller can stop polling; false means keep waiting.
      const tryResolve = (): boolean => {
        if (closed) return true;
        const r = source.resolve();
        if (r.kind === "fail") {
          // Can't HTTP-fail after the stream opened — just stop cleanly.
          cleanup();
          return true;
        }
        if (r.kind === "ready" && existsSync(r.path)) {
          beginTailing(r.path);
          return true;
        }
        return false; // wait
      };

      heartbeat = setInterval(() => enqueue(": ping\n\n"), HEARTBEAT_MS);

      // Fast path: file already present. Otherwise poll until it appears.
      if (!tryResolve()) {
        resolvePoll = setInterval(() => {
          if (tryResolve() && resolvePoll) {
            clearInterval(resolvePoll);
            resolvePoll = null;
          }
        }, resolvePollMs());
      }
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
