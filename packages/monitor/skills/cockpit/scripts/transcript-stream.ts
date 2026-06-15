// cockpit live-transcript SSE — GET /api/transcript/stream?session=<uuid>
// streams a Claude Code or Codex transcript: a backlog of the most recent lines
// (read backward in chunks, decoded once for UTF-8 safety), a backlog-done
// marker, then live appends tailed via fs.watch. Adapted from token-atlas's
// live.ts streamTranscript.
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { codexDir, codexStateDb, resolveCodexPath } from "./codex-db";
import {
  createTailStream,
  jsonError,
  splitCompleteLines,
  type ResolveResult,
} from "./sse-tailer";
import { jsonResponse } from "./http";

const UUID_RE = /^[0-9a-f-]{36}$/;
const OPENCODE_ID_RE = /^[A-Za-z0-9_.:-]+$/;
const BACKLOG_LINES = 50;
const BACKLOG_READ_CHUNK_BYTES = 256 * 1024;
const MAX_BACKLOG_READ_BYTES = 2 * 1024 * 1024;
type Provider = "claude" | "codex" | "opencode";

type CodexThreadRow = {
  rollout_path: string;
};

type OpenCodeMessageRow = {
  message_id: string;
  message_created: number;
  message_updated: number;
  message_data: string;
  part_id: string | null;
  part_created: number | null;
  part_data: string | null;
};

// Only conversation entries are streamed; everything else is session-metadata
// bookkeeping (file-history-snapshot, queue-operation, last-prompt, …) that
// repeats in the file and adds noise. Allowlist (not denylist) because new
// metadata types keep appearing while conversation types do not. Tool calls /
// results ride inside the content of user/assistant entries, so this carries them.
const DISPLAY_ENTRY_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "tool",
  "tool_use",
  "tool_result",
  "response_item",
]);

// Claude transcripts live under ~/.claude/projects/**/<id>.jsonl. The base dir
// is overridable via COCKPIT_CLAUDE_PROJECTS_DIR so tests can point at a temp
// fixture tree (mirrors the COCKPIT_HOME override the rest of the daemon uses).
function claudeProjectsDir(): string {
  return (
    process.env.COCKPIT_CLAUDE_PROJECTS_DIR ||
    join(homedir(), ".claude", "projects")
  );
}

function codexSessionsDir(): string {
  return process.env.COCKPIT_CODEX_SESSIONS_DIR || join(codexDir(), "sessions");
}

function openCodeDb(): string {
  return (
    process.env.COCKPIT_OPENCODE_DB ||
    join(
      process.env.OPENCODE_DATA_DIR ||
        join(homedir(), ".local", "share", "opencode"),
      "opencode.db",
    )
  );
}

// Canonical projects root for the realpath-confinement check.
function projectsReal(): string {
  const dir = claudeProjectsDir();
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function codexSessionsReal(): string {
  const dir = codexSessionsDir();
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export function resolveClaudeTranscriptPath(id: string): string | undefined {
  const dir = claudeProjectsDir();
  if (!existsSync(dir)) return undefined;
  const glob = new Glob(`**/${id}.jsonl`);
  for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true })) {
    return join(dir, rel);
  }
  return undefined;
}

export function resolveCodexRolloutPath(id: string): string | undefined {
  const dbPath = codexStateDb();
  if (!existsSync(dbPath)) return undefined;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query(
          `select rollout_path
           from threads
           where id = ? and archived = 0 and rollout_path != ''
           limit 1`,
        )
        .get(id) as CodexThreadRow | null;
      if (!row?.rollout_path) return undefined;
      return resolveCodexPath(row.rollout_path);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export function isInsideProjects(filePath: string): boolean {
  const rel = relative(projectsReal(), filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function isInsideCodexSessions(filePath: string): boolean {
  const rel = relative(codexSessionsReal(), filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function normalizeProvider(provider: string | null): Provider | null {
  if (!provider || provider === "claude") return "claude";
  if (provider === "codex") return "codex";
  if (provider === "opencode") return "opencode";
  return null;
}

function validSessionId(provider: Provider, session: string): boolean {
  return provider === "opencode"
    ? OPENCODE_ID_RE.test(session) && session.length <= 160
    : UUID_RE.test(session);
}

function resolveProviderTranscriptPath(
  provider: Provider,
  id: string,
): string | undefined {
  return provider === "codex"
    ? resolveCodexRolloutPath(id)
    : resolveClaudeTranscriptPath(id);
}

function isInsideProviderRoot(provider: Provider, filePath: string): boolean {
  return provider === "codex"
    ? isInsideCodexSessions(filePath)
    : isInsideProjects(filePath);
}

function providerRootName(provider: Provider): string {
  if (provider === "opencode") return "OpenCode database";
  return provider === "codex" ? "Codex sessions" : "~/.claude/projects";
}

function safeParseJSON<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function openCodeTimestampIso(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  return new Date(ms).toISOString();
}

function compactOpenCodePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-3).join("/") || path;
}

function openCodePartContent(part: unknown): unknown | null {
  if (!part || typeof part !== "object") return null;
  const p = part as {
    type?: string;
    text?: string;
    content?: string;
    name?: string;
    input?: unknown;
    files?: unknown;
  };
  if (p.type === "text" && typeof p.text === "string") {
    return { type: "text", text: p.text };
  }
  if (p.type === "reasoning" && typeof p.text === "string") {
    return { type: "thinking", thinking: p.text };
  }
  if (p.type === "tool") {
    return {
      type: "tool_use",
      name: p.name ?? "tool",
      input: p.input ?? part,
    };
  }
  if (p.type === "step-start" || p.type === "step-finish") {
    return null;
  }
  if (p.type === "patch") {
    const files = Array.isArray(p.files)
      ? p.files.filter((file): file is string => typeof file === "string")
      : [];
    if (!files.length) return null;
    return {
      type: "text",
      text: [
        "Changed files:",
        ...files.map((file) => `- \`${compactOpenCodePath(file)}\``),
      ].join("\n"),
    };
  }
  const text = p.text ?? p.content;
  if (typeof text === "string") return { type: "text", text };
  return { type: "text", text: JSON.stringify(part, null, 2) };
}

function openCodeRowsToEntries(rows: OpenCodeMessageRow[]): unknown[] {
  const grouped = new Map<
    string,
    {
      row: OpenCodeMessageRow;
      parts: unknown[];
    }
  >();
  for (const row of rows) {
    const group = grouped.get(row.message_id) ?? { row, parts: [] };
    grouped.set(row.message_id, group);
    const part = safeParseJSON<unknown>(row.part_data);
    const content = openCodePartContent(part);
    if (content) group.parts.push(content);
  }

  const entries: unknown[] = [];
  for (const { row, parts } of grouped.values()) {
    const data = safeParseJSON<{
      role?: string;
      content?: unknown;
      text?: string;
      summary?: unknown;
    }>(row.message_data);
    const role = data?.role === "user" ? "user" : "assistant";
    const fallbackContent =
      data?.content ??
      data?.text ??
      (data?.summary ? JSON.stringify(data.summary, null, 2) : "");
    const content = parts.length ? parts : fallbackContent;
    entries.push({
      type: role,
      uuid: row.message_id,
      timestamp: openCodeTimestampIso(row.message_updated),
      message: {
        role,
        content,
      },
      provider: "opencode",
    });
  }
  return entries;
}

function readOpenCodeRows(
  session: string,
  afterUpdated = 0,
  limit = BACKLOG_LINES,
): OpenCodeMessageRow[] {
  const dbPath = openCodeDb();
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db
        .query(
          `select
             m.id as message_id,
             m.time_created as message_created,
             m.time_updated as message_updated,
             m.data as message_data,
             p.id as part_id,
             p.time_created as part_created,
             p.data as part_data
           from (
             select id, session_id, time_created, time_updated, data
             from message
             where session_id = ? and time_updated > ?
             order by time_updated desc, id desc
             limit ?
           ) m
           left join part p on p.message_id = m.id
           order by m.time_created asc, m.id asc, p.time_created asc, p.id asc`,
        )
        .all(session, afterUpdated, limit) as OpenCodeMessageRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function maxOpenCodeUpdated(
  rows: OpenCodeMessageRow[],
  current: number,
): number {
  return rows.reduce(
    (max, row) =>
      Math.max(max, row.message_updated || row.message_created || 0),
    current,
  );
}

function createOpenCodeTranscriptStream(session: string): Response {
  let closed = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const cleanup = () => {
    closed = true;
    if (poll) clearInterval(poll);
    if (heartbeat) clearInterval(heartbeat);
    poll = heartbeat = null;
  };

  const stream = new ReadableStream({
    start(controller) {
      let cursor = 0;
      const seen = new Set<string>();
      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          cleanup();
        }
      };
      const emitRows = (rows: OpenCodeMessageRow[]) => {
        cursor = maxOpenCodeUpdated(rows, cursor);
        for (const entry of openCodeRowsToEntries(rows) as Array<{
          uuid?: string;
        }>) {
          if (entry.uuid && seen.has(entry.uuid)) continue;
          if (entry.uuid) seen.add(entry.uuid);
          enqueue(`data: ${JSON.stringify(entry)}\n\n`);
        }
      };

      enqueue(": connected\n\n");
      const backlog = readOpenCodeRows(session, 0, BACKLOG_LINES);
      emitRows(backlog);
      enqueue(`event: backlog-done\ndata: ${JSON.stringify({})}\n\n`);

      poll = setInterval(
        () => {
          emitRows(readOpenCodeRows(session, cursor, BACKLOG_LINES));
        },
        Number(process.env.COCKPIT_TAIL_POLL_MS) || 2_000,
      );
      heartbeat = setInterval(() => enqueue(": ping\n\n"), 25_000);
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

// True when an entry is a displayable conversation line (not metadata noise).
// Shared by the SSE tail (emitLines) and the history page (parseEntries) so both
// filter identically.
function isDisplayEntry(entry: { type?: string } | null): boolean {
  if (!entry || !DISPLAY_ENTRY_TYPES.has(entry.type ?? "")) return false;
  if (entry.type === "response_item") {
    const payloadType = (entry as { payload?: { type?: string } }).payload
      ?.type;
    if (
      payloadType !== "message" &&
      payloadType !== "function_call" &&
      payloadType !== "function_call_output" &&
      payloadType !== "custom_tool_call"
    ) {
      return false;
    }
  }
  return true;
}

// Emit each conversation entry in `text` as its own SSE data frame; skip blank,
// malformed, and metadata-noise lines so one bad line never kills the stream.
function emitLines(enqueue: (chunk: string) => void, text: string): void {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { type?: string };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isDisplayEntry(entry)) continue;
    enqueue(`data: ${JSON.stringify(entry)}\n\n`);
  }
}

// Parse + filter JSONL lines into displayable entry objects (oldest first), for
// the history page. Mirrors emitLines' filter but returns objects, not frames.
function parseEntries(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { type?: string };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isDisplayEntry(entry)) out.push(entry);
  }
  return out;
}

// Read up to `maxLines` complete lines ending at byte offset `endOffset`,
// scanning backward in chunks. Decodes once so multi-byte chars spanning a
// chunk boundary aren't corrupted. Returns lines oldest-first, the trailing
// partial after the last newline (meaningful only when endOffset is EOF), and
// `startOffset` — the byte offset where the first returned line begins, used as
// the cursor for loading still-older history (0 means start-of-file reached).
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
      // 0x0A ("\n") is never a UTF-8 continuation byte, so scanning raw bytes
      // is safe and far faster than decoding first.
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
  // Byte distance from the first returned line to endOffset = the returned lines
  // (each followed by "\n") plus the trailing partial.
  const tailText = lines.length ? `${lines.join("\n")}\n${partial}` : partial;
  const startOffset = Math.max(0, endOffset - Buffer.byteLength(tailText));
  return { lines, partial, startOffset };
}

export function handleTranscriptStream(req: Request): Response {
  const url = new URL(req.url);
  const session = url.searchParams.get("session") ?? "";
  const provider = normalizeProvider(url.searchParams.get("provider"));
  if (!provider) return jsonError("invalid provider");
  if (!validSessionId(provider, session))
    return jsonError("invalid session id");
  if (provider === "opencode") return createOpenCodeTranscriptStream(session);

  // A Claude/Codex transcript can be created moments after the session is
  // selected, so "not found" is a transient `wait`, not a 404 — the tailer keeps
  // the connection open and re-resolves until it appears.
  const resolve = (): ResolveResult => {
    const resolved = resolveProviderTranscriptPath(provider, session);
    if (!resolved) return { kind: "wait" };
    let filePath: string;
    try {
      filePath = realpathSync(resolved);
    } catch {
      return { kind: "wait" };
    }
    if (!isInsideProviderRoot(provider, filePath)) {
      return {
        kind: "fail",
        message: `transcript path is outside ${providerRootName(provider)}`,
        status: 403,
      };
    }
    return { kind: "ready", path: filePath };
  };

  return createTailStream({
    resolve,
    readBacklog: (path, size) => {
      // the most recent BACKLOG_LINES, read backward
      const { lines, partial, startOffset } = readLinesEndingAt(
        path,
        size,
        BACKLOG_LINES,
      );
      return {
        complete: lines.join("\n"),
        partial,
        // Ship the reverse-scroll cursor so the client can page older history.
        backlogMeta: { historyStart: startOffset, hasMore: startOffset > 0 },
      };
    },
    emit: emitLines,
  });
}

// Older-history page for the transcript modal's reverse-scroll. Returns the
// displayable entries immediately before byte offset `before`, plus the next
// cursor — GET /api/transcript/history?session=&provider=&before=&limit=.
const MAX_HISTORY_LIMIT = 200;

export function handleTranscriptHistory(req: Request): Response {
  const url = new URL(req.url);
  const session = url.searchParams.get("session") ?? "";
  const provider = normalizeProvider(url.searchParams.get("provider"));
  const before = Number(url.searchParams.get("before"));
  const limit = Number(url.searchParams.get("limit"));
  if (!provider) return jsonError("invalid provider");
  if (!validSessionId(provider, session))
    return jsonError("invalid session id");

  const empty = { entries: [], historyStart: 0, hasMore: false };
  if (provider === "opencode") return jsonResponse(empty);
  if (!Number.isFinite(before) || before <= 0) return jsonResponse(empty);

  const resolved = resolveProviderTranscriptPath(provider, session);
  if (!resolved) return jsonResponse(empty);
  let filePath: string;
  try {
    filePath = realpathSync(resolved);
  } catch {
    return jsonResponse(empty);
  }
  if (!isInsideProviderRoot(provider, filePath)) {
    return jsonError(
      `transcript path is outside ${providerRootName(provider)}`,
      403,
    );
  }

  try {
    // Clamp to the live size in case the file was truncated/rotated since the
    // cursor was issued, so we never read past EOF into uninitialized bytes.
    const size = statSync(filePath).size;
    const endOffset = Math.min(before, size);
    const cap = Math.min(
      Math.max(1, limit || BACKLOG_LINES),
      MAX_HISTORY_LIMIT,
    );
    const { lines, startOffset } = readLinesEndingAt(filePath, endOffset, cap);
    return jsonResponse({
      entries: parseEntries(lines),
      historyStart: startOffset,
      hasMore: startOffset > 0,
    });
  } catch {
    return jsonError("failed to read transcript history", 500);
  }
}
