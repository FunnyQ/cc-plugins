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
import { isAbsolute, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { Glob } from "bun";

const CLAUDE_DIR = join(homedir(), ".claude");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const CODEX_DIR = join(homedir(), ".codex");
const CODEX_STATE_DB = join(CODEX_DIR, "state_5.sqlite");
const CODEX_SESSIONS_DIR = join(CODEX_DIR, "sessions");
// Resolve the projects root once: relative() needs the canonical base to
// compare against the realpath'd transcript paths, and the dir is stable.
const PROJECTS_REAL = (() => {
  try {
    return realpathSync(PROJECTS_DIR);
  } catch {
    return PROJECTS_DIR;
  }
})();
const CODEX_SESSIONS_REAL = (() => {
  try {
    return realpathSync(CODEX_SESSIONS_DIR);
  } catch {
    return CODEX_SESSIONS_DIR;
  }
})();
const STALE_CUTOFF_MS = 10 * 60 * 1000;
const CODEX_BUSY_CUTOFF_MS = 60 * 1000;
const UUID_RE = /^[0-9a-f-]{36}$/;
const BACKLOG_LINES = 50;
const BACKLOG_READ_CHUNK_BYTES = 256 * 1024;
const MAX_BACKLOG_READ_BYTES = 2 * 1024 * 1024;
const HEARTBEAT_MS = 10_000;
const RESOLVE_POLL_MS = 2_000;
const TRANSCRIPT_INDEX_TTL_MS = 5_000;
// Only conversation entries are streamed. Tool calls/results live inside the
// content of `user`/`assistant` entries, so this allowlist still carries them.
// Everything excluded is session-metadata bookkeeping (progress, file-history-
// snapshot, queue-operation, last-prompt, ai-title, agent-name, permission-mode,
// pr-link, …) — not conversation, and it repeats in the file, which otherwise
// piles up duplicate noise in the modal. An allowlist is used (not a denylist)
// because new metadata types keep appearing; conversation types do not.
const DISPLAY_ENTRY_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "tool",
  "tool_use",
  "tool_result",
  "response_item",
]);
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

type CodexThreadRow = {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  created_at_ms?: number | null;
  updated_at_ms?: number | null;
  cwd: string;
  title: string;
  model: string | null;
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

export function resolveClaudeTranscriptPath(id: string): string | undefined {
  if (!existsSync(PROJECTS_DIR)) return undefined;
  const glob = new Glob(`**/${id}.jsonl`);
  for (const rel of glob.scanSync({ cwd: PROJECTS_DIR, onlyFiles: true })) {
    return join(PROJECTS_DIR, rel);
  }
  return undefined;
}

export const resolveTranscriptPath = resolveClaudeTranscriptPath;

function readCodexThreadRows(limit = 24): CodexThreadRow[] {
  if (!existsSync(CODEX_STATE_DB)) return [];
  try {
    const db = new Database(CODEX_STATE_DB, { readonly: true });
    try {
      return db
        .query(
          `select id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, cwd, title, model
           from threads
           where archived = 0 and rollout_path != ''
           order by coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000) desc
           limit ?`,
        )
        .all(limit) as CodexThreadRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function readCodexThreadRow(id: string): CodexThreadRow | null {
  if (!existsSync(CODEX_STATE_DB)) return null;
  try {
    const db = new Database(CODEX_STATE_DB, { readonly: true });
    try {
      return (
        (db
          .query(
            `select id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, cwd, title, model
             from threads
             where id = ? and archived = 0 and rollout_path != ''
             limit 1`,
          )
          .get(id) as CodexThreadRow | null) ?? null
      );
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function codexUpdatedAtMs(row: CodexThreadRow): number {
  return (
    row.updated_at_ms ||
    (row.updated_at ? row.updated_at * 1000 : 0) ||
    row.created_at_ms ||
    row.created_at * 1000
  );
}

function resolveCodexRolloutPath(id: string): string | undefined {
  const row = readCodexThreadRow(id);
  if (!row?.rollout_path) return undefined;
  return isAbsolute(row.rollout_path)
    ? row.rollout_path
    : resolve(CODEX_DIR, row.rollout_path);
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

export function isInsideCodexSessions(filePath: string): boolean {
  const rel = relative(CODEX_SESSIONS_REAL, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function statusRank(status: string): number {
  if (status === "busy" || status === "active-inferred") return 0;
  if (status === "waiting") return 1;
  if (status === "recent") return 2;
  if (status === "idle") return 3;
  return 4;
}

export function getLiveSessions(): LiveSession[] {
  const now = Date.now();
  const index = getTranscriptIndex();
  const claudeSessions = readSessionFiles()
    .map((session) => {
      const updatedAtMs = session.updatedAt ?? session.startedAt;
      const ageMs = Math.max(0, now - updatedAtMs);
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
    .filter((session) => !session.isStale);

  const codexSessions = readCodexThreadRows()
    .map((row) => {
      const updatedAtMs = codexUpdatedAtMs(row);
      const ageMs = Math.max(0, now - updatedAtMs);
      return {
        provider: "codex",
        id: row.id,
        projectName: projectNameFor(row.cwd),
        cwd: row.cwd,
        status: ageMs <= CODEX_BUSY_CUTOFF_MS ? "active-inferred" : "recent",
        statusSource: "codex-sqlite-rollout",
        updatedAt: new Date(updatedAtMs).toISOString(),
        ageMs,
        isStale: ageMs > STALE_CUTOFF_MS,
        transcriptPath: row.rollout_path || undefined,
        model: row.model ?? undefined,
      } satisfies LiveSession;
    })
    .filter(
      (session) =>
        !session.isStale &&
        !!session.transcriptPath &&
        existsSync(session.transcriptPath),
    );

  return [...claudeSessions, ...codexSessions].sort((a, b) => {
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

// Parse JSONL lines into displayable entries, skipping blank/malformed lines
// and the noise types. Shared by the SSE stream and the history endpoint.
function parseEntries(lines: string[]): object[] {
  const out: object[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { type?: string };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed / partially-written JSONL entries
    }
    if (!entry || !DISPLAY_ENTRY_TYPES.has(entry.type ?? "")) continue;
    if (entry.type === "response_item") {
      const payloadType = (entry as { payload?: { type?: string } }).payload
        ?.type;
      if (
        payloadType !== "message" &&
        payloadType !== "function_call" &&
        payloadType !== "function_call_output" &&
        payloadType !== "custom_tool_call"
      ) {
        continue;
      }
    }
    out.push(entry);
  }
  return out;
}

function emitLines(
  controller: ReadableStreamDefaultController,
  text: string,
): void {
  for (const entry of parseEntries(text.split("\n"))) sse(controller, entry);
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

// Read up to `maxLines` complete JSONL lines ending at byte offset `endOffset`,
// scanning backward in chunks. Returns the lines (oldest first), the trailing
// partial text after the last newline (only meaningful when endOffset is EOF),
// and `startOffset` — the byte offset where the first returned line begins, used
// as the cursor for loading still-older history. startOffset 0 means we reached
// the start of the file. Decodes once so multi-byte chars spanning a chunk
// boundary aren't corrupted.
function readLinesEndingAt(
  filePath: string,
  endOffset: number,
  maxLines: number,
): { lines: string[]; partial: string; startOffset: number } {
  let start = endOffset;
  let newlineCount = 0;
  const chunks: Buffer[] = [];
  const fd = openSync(filePath, "r");
  try {
    while (start > 0 && endOffset - start < MAX_BACKLOG_READ_BYTES) {
      const nextStart = Math.max(0, start - BACKLOG_READ_CHUNK_BYTES);
      const length = start - nextStart;
      const buf = Buffer.allocUnsafe(length);
      readSync(fd, buf, 0, length, nextStart);
      chunks.unshift(buf);
      start = nextStart;
      // Native scan for "\n" (0x0A) — never a UTF-8 continuation byte, so safe
      // on raw bytes and far faster than iterating each byte in JS.
      for (
        let nl = buf.indexOf(0x0a);
        nl !== -1;
        nl = buf.indexOf(0x0a, nl + 1)
      ) {
        newlineCount++;
      }
      if (newlineCount >= maxLines) break;
    }
  } finally {
    closeSync(fd);
  }
  let body = Buffer.concat(chunks).toString("utf-8");
  if (start > 0) {
    // Began mid-file, so the first line is probably partial — drop it.
    const firstNewline = body.indexOf("\n");
    body = firstNewline >= 0 ? body.slice(firstNewline + 1) : "";
  }
  const { complete, partial } = splitCompleteLines(body);
  const lines = complete ? complete.split("\n").slice(-maxLines) : [];
  // Byte distance from the first returned line to endOffset = the returned
  // lines (each followed by "\n") plus the trailing partial.
  const tailText = lines.length ? `${lines.join("\n")}\n${partial}` : partial;
  const startOffset = Math.max(0, endOffset - Buffer.byteLength(tailText));
  return { lines, partial, startOffset };
}

type LiveProvider = "claude" | "codex";

function normalizeProvider(provider: string | null): LiveProvider | null {
  if (!provider || provider === "claude") return "claude";
  if (provider === "codex") return "codex";
  return null;
}

function resolveProviderTranscriptPath(
  provider: LiveProvider,
  id: string,
): string | undefined {
  return provider === "codex"
    ? resolveCodexRolloutPath(id)
    : resolveClaudeTranscriptPath(id);
}

function isInsideProviderRoot(
  provider: LiveProvider,
  filePath: string,
): boolean {
  return provider === "codex"
    ? isInsideCodexSessions(filePath)
    : isInsideProjects(filePath);
}

function providerRootName(provider: LiveProvider): string {
  return provider === "codex" ? "Codex sessions" : "projects";
}

export function streamTranscript(
  sessionId: string | null,
  providerParam: string | null = "claude",
): Response {
  const provider = normalizeProvider(providerParam);
  if (!provider) return jsonResponse({ error: "invalid provider" }, 400);
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return jsonResponse({ error: "invalid session id" }, 400);
  }

  let initialPath: string | undefined = resolveProviderTranscriptPath(
    provider,
    sessionId,
  );
  if (initialPath) {
    try {
      initialPath = realpathSync(initialPath);
    } catch {
      initialPath = undefined;
    }
    if (initialPath && !isInsideProviderRoot(provider, initialPath)) {
      return jsonResponse(
        { error: `transcript path is outside ${providerRootName(provider)}` },
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
    let historyStart = 0;
    try {
      const size = statSync(filePath).size;
      const {
        lines,
        partial: trailing,
        startOffset,
      } = readLinesEndingAt(filePath, size, BACKLOG_LINES);
      emitLines(controller, lines.join("\n"));
      partial = trailing;
      offset = size;
      historyStart = startOffset;
    } catch {
      // File vanished/rotated between resolve and read; the next poll retries.
    }
    sse(controller, {
      kind: "backlog-done",
      historyStart,
      hasMore: historyStart > 0,
    });
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
    try {
      watcher = watch(filePath, () => scheduleTail(controller));
    } catch {
      filePath = undefined;
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      safeEnqueue(controller, ": connected\n\n");
      if (filePath) startWatching(controller, filePath);

      resolvePoll = setInterval(() => {
        if (closed || watcher) return;
        const resolved = resolveProviderTranscriptPath(provider, sessionId);
        if (!resolved) return;
        let realPath: string;
        try {
          realPath = realpathSync(resolved);
        } catch {
          // Resolved then vanished before realpath; wait for the next tick.
          return;
        }
        if (!isInsideProviderRoot(provider, realPath)) {
          safeEnqueue(
            controller,
            `data: ${JSON.stringify({ error: `transcript path is outside ${providerRootName(provider)}` })}\n\n`,
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

// Older-history page for the streaming modal's reverse-scroll. Returns the
// entries immediately before byte offset `before`, plus the next cursor.
export function getTranscriptHistory(
  sessionId: string | null,
  before: number,
  limit: number,
  providerParam: string | null = "claude",
): Response {
  const provider = normalizeProvider(providerParam);
  if (!provider) return jsonResponse({ error: "invalid provider" }, 400);
  if (!sessionId || !UUID_RE.test(sessionId)) {
    return jsonResponse({ error: "invalid session id" }, 400);
  }
  const empty = { entries: [], historyStart: 0, hasMore: false };
  if (!Number.isFinite(before) || before <= 0) return jsonResponse(empty);

  let path = resolveProviderTranscriptPath(provider, sessionId);
  if (!path) return jsonResponse(empty);
  try {
    path = realpathSync(path);
  } catch {
    return jsonResponse(empty);
  }
  if (!isInsideProviderRoot(provider, path)) {
    return jsonResponse(
      { error: `transcript path is outside ${providerRootName(provider)}` },
      403,
    );
  }

  try {
    // Clamp to the live size in case the file was truncated/rotated since the
    // cursor was issued, so we never read past EOF into uninitialized bytes.
    const size = statSync(path).size;
    const endOffset = Math.min(before, size);
    const cap = Math.min(Math.max(1, limit || BACKLOG_LINES), 200);
    const { lines, startOffset } = readLinesEndingAt(path, endOffset, cap);
    return jsonResponse({
      entries: parseEntries(lines),
      historyStart: startOffset,
      hasMore: startOffset > 0,
    });
  } catch (err) {
    return jsonError(err);
  }
}

if (import.meta.main) {
  process.stdout.write(
    JSON.stringify({ sessions: getLiveSessions() }, null, 2),
  );
}
