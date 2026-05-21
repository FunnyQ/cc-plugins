#!/usr/bin/env bun
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { Glob } from "bun";

const CLAUDE_DIR = join(homedir(), ".claude");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
// Resolve the projects root once: relative() needs the canonical base to
// compare against the realpath'd transcript paths, and the dir is stable.
const PROJECTS_REAL = (() => {
  try {
    return realpathSync(PROJECTS_DIR);
  } catch {
    return PROJECTS_DIR;
  }
})();
const STALE_CUTOFF_MS = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f-]{36}$/;
const BACKLOG_LINES = 50;
const HEARTBEAT_MS = 10_000;
const RESOLVE_POLL_MS = 2_000;
const TRANSCRIPT_INDEX_TTL_MS = 5_000;
// Subagent `progress` records have no message body and would render as an opaque
// JSON blob in the modal, so they're dropped at the source. Everything else
// (user / assistant / tool / tool_result / system) passes through per the stream
// contract — this is a denylist, not an allowlist, so no conversation type is
// accidentally excluded.
const SKIP_ENTRY_TYPES = new Set(["progress"]);
const WATCH_DEBOUNCE_MS = 80;

type ClaudeSessionFile = {
  pid: number;
  sessionId: string;
  cwd: string;
  status: "busy" | "idle" | "waiting" | string;
  startedAt: number;
  updatedAt?: number;
  version?: string;
  kind?: string;
  entrypoint?: string;
};

export type LiveSession = {
  provider: "claude" | "codex";
  id: string;
  projectName: string;
  cwd: string;
  status: "busy" | "idle" | "waiting" | string;
  statusSource:
    | "claude-session-file"
    | "codex-app-server"
    | "codex-sqlite-rollout";
  updatedAt: string;
  ageMs: number;
  isStale: boolean;
  transcriptPath?: string;
  model?: string;
  version?: string;
};

function readSessionFiles(): ClaudeSessionFile[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const out: ClaudeSessionFile[] = [];
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
      if (
        data &&
        typeof data.sessionId === "string" &&
        typeof data.cwd === "string" &&
        typeof data.startedAt === "number"
      ) {
        out.push(data);
      }
    } catch {
      // skip malformed / partially-written file
    }
  }
  return out;
}

function projectNameFor(cwd: string): string {
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
}

export function resolveTranscriptPath(id: string): string | undefined {
  if (!existsSync(PROJECTS_DIR)) return undefined;
  const glob = new Glob(`**/${id}.jsonl`);
  for (const rel of glob.scanSync({ cwd: PROJECTS_DIR, onlyFiles: true })) {
    return join(PROJECTS_DIR, rel);
  }
  return undefined;
}

let transcriptIndex: Map<string, string> | null = null;
let transcriptIndexAt = 0;

// Build a sessionId -> transcript-path map in a single tree walk, cached for a
// few seconds. The /api/live poll runs every 3s; resolving each session's path
// with its own `**/<id>.jsonl` glob was an O(sessions) full-tree walk per poll.
// One scan keyed by filename stem is O(1) in session count, and the TTL means
// most polls do no fs work at all. The stream endpoint deliberately does NOT use
// this cache — a brand-new transcript must resolve immediately.
function getTranscriptIndex(): Map<string, string> {
  const now = Date.now();
  if (transcriptIndex && now - transcriptIndexAt < TRANSCRIPT_INDEX_TTL_MS) {
    return transcriptIndex;
  }
  const index = new Map<string, string>();
  if (existsSync(PROJECTS_DIR)) {
    const glob = new Glob("**/*.jsonl");
    for (const rel of glob.scanSync({ cwd: PROJECTS_DIR, onlyFiles: true })) {
      const stem = rel.slice(rel.lastIndexOf("/") + 1, -".jsonl".length);
      if (!index.has(stem)) index.set(stem, join(PROJECTS_DIR, rel));
    }
  }
  transcriptIndex = index;
  transcriptIndexAt = now;
  return index;
}

export function isInsideProjects(filePath: string): boolean {
  const rel = relative(PROJECTS_REAL, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function statusRank(status: string): number {
  if (status === "waiting") return 0;
  if (status === "busy") return 1;
  if (status === "idle") return 2;
  return 3;
}

export function getLiveSessions(): LiveSession[] {
  const now = Date.now();
  const index = getTranscriptIndex();
  return readSessionFiles()
    .map((session) => {
      const updatedAtMs = session.updatedAt ?? session.startedAt;
      const ageMs = now - updatedAtMs;
      return {
        provider: "claude",
        id: session.sessionId,
        projectName: projectNameFor(session.cwd),
        cwd: session.cwd,
        status: session.status,
        statusSource: "claude-session-file",
        updatedAt: new Date(updatedAtMs).toISOString(),
        ageMs,
        isStale: ageMs > STALE_CUTOFF_MS,
        transcriptPath: index.get(session.sessionId),
        version: session.version,
      } satisfies LiveSession;
    })
    .filter((session) => !session.isStale)
    .sort((a, b) => {
      const statusDelta = statusRank(a.status) - statusRank(b.status);
      if (statusDelta !== 0) return statusDelta;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
}

export function jsonResponse(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function jsonError(err: unknown, status = 500): Response {
  const msg = err instanceof Error ? err.message : String(err);
  return jsonResponse({ error: msg }, status);
}

function sse(controller: ReadableStreamDefaultController, payload: object) {
  controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`);
}

function emitLines(
  controller: ReadableStreamDefaultController,
  text: string,
): void {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { type?: string };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed / partially-written JSONL entries
    }
    if (!entry || SKIP_ENTRY_TYPES.has(entry.type ?? "")) continue;
    sse(controller, entry);
  }
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

export function streamTranscript(sessionId: string | null): Response {
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return jsonResponse({ error: "invalid session id" }, 400);
  }

  let initialPath = resolveTranscriptPath(sessionId);
  if (initialPath) {
    initialPath = realpathSync(initialPath);
    if (!isInsideProjects(initialPath)) {
      return jsonResponse(
        { error: "transcript path is outside projects" },
        403,
      );
    }
  }

  let watcher: FSWatcher | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let resolvePoll: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let filePath = initialPath;
  let offset = 0;
  let partial = "";

  function cleanup(): void {
    closed = true;
    watcher?.close();
    watcher = null;
    if (heartbeat) clearInterval(heartbeat);
    if (resolvePoll) clearInterval(resolvePoll);
    if (debounceTimer) clearTimeout(debounceTimer);
  }

  function safeEnqueue(
    controller: ReadableStreamDefaultController,
    chunk: string,
  ): void {
    if (closed) return;
    try {
      controller.enqueue(chunk);
    } catch {
      cleanup();
    }
  }

  function readBacklog(controller: ReadableStreamDefaultController): void {
    if (!filePath || closed) return;
    try {
      const body = readFileSync(filePath, "utf-8");
      const { complete, partial: trailing } = splitCompleteLines(body);
      // Cap the displayed backlog, but resume tailing from the true EOF so the
      // partial-line buffer stays aligned with the file's byte length.
      const lines = complete ? complete.split("\n").slice(-BACKLOG_LINES) : [];
      emitLines(controller, lines.join("\n"));
      partial = trailing;
      offset = Buffer.byteLength(body);
    } catch {
      // File vanished/rotated between resolve and read; the next poll retries.
    }
    sse(controller, { kind: "backlog-done" });
  }

  function readTail(controller: ReadableStreamDefaultController): void {
    if (!filePath || closed) return;
    try {
      const size = statSync(filePath).size;
      if (size < offset) {
        offset = 0;
        partial = "";
      }
      if (size <= offset) return;
      // Read only the appended [offset, size) slice — re-reading the whole
      // (potentially multi-MB) transcript on every append is O(filesize) per line.
      const length = size - offset;
      const buf = Buffer.allocUnsafe(length);
      const fd = openSync(filePath, "r");
      try {
        readSync(fd, buf, 0, length, offset);
      } finally {
        closeSync(fd);
      }
      offset = size;
      const lines = splitCompleteLines(partial + buf.toString("utf-8"));
      partial = lines.partial;
      emitLines(controller, lines.complete);
    } catch {
      // The file may be rotating or mid-write; the next watch/poll can retry.
    }
  }

  function scheduleTail(controller: ReadableStreamDefaultController): void {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      readTail(controller);
    }, WATCH_DEBOUNCE_MS);
  }

  function startWatching(
    controller: ReadableStreamDefaultController,
    resolvedPath: string,
  ): void {
    if (closed || watcher) return;
    filePath = resolvedPath;
    readBacklog(controller);
    watcher = watch(filePath, () => scheduleTail(controller));
  }

  const stream = new ReadableStream({
    start(controller) {
      safeEnqueue(controller, ": connected\n\n");
      if (filePath) startWatching(controller, filePath);

      resolvePoll = setInterval(() => {
        if (closed || watcher) return;
        const resolved = resolveTranscriptPath(sessionId);
        if (!resolved) return;
        let realPath: string;
        try {
          realPath = realpathSync(resolved);
        } catch {
          // Resolved then vanished before realpath; wait for the next tick.
          return;
        }
        if (!isInsideProjects(realPath)) {
          safeEnqueue(
            controller,
            `data: ${JSON.stringify({ error: "transcript path is outside projects" })}\n\n`,
          );
          cleanup();
          controller.close();
          return;
        }
        startWatching(controller, realPath);
      }, RESOLVE_POLL_MS);

      heartbeat = setInterval(() => {
        safeEnqueue(controller, ": ping\n\n");
      }, HEARTBEAT_MS);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

if (import.meta.main) {
  process.stdout.write(
    JSON.stringify({ sessions: getLiveSessions() }, null, 2),
  );
}
