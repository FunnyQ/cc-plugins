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
  watch,
  type FSWatcher,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { Glob } from "bun";

const UUID_RE = /^[0-9a-f-]{36}$/;
const BACKLOG_LINES = 50;
const BACKLOG_READ_CHUNK_BYTES = 256 * 1024;
const MAX_BACKLOG_READ_BYTES = 2 * 1024 * 1024;
const WATCH_DEBOUNCE_MS = 80;
const HEARTBEAT_MS = 25_000;
type Provider = "claude" | "codex";

type CodexThreadRow = {
  rollout_path: string;
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

function codexDir(): string {
  return process.env.COCKPIT_CODEX_DIR || join(homedir(), ".codex");
}

function codexStateDb(): string {
  return (
    process.env.COCKPIT_CODEX_STATE_DB || join(codexDir(), "state_5.sqlite")
  );
}

function codexSessionsDir(): string {
  return process.env.COCKPIT_CODEX_SESSIONS_DIR || join(codexDir(), "sessions");
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
      return isAbsolute(row.rollout_path)
        ? row.rollout_path
        : resolve(codexDir(), row.rollout_path);
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
  return null;
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
  return provider === "codex" ? "Codex sessions" : "~/.claude/projects";
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
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
    enqueue(`data: ${JSON.stringify(entry)}\n\n`);
  }
}

// Read up to `maxLines` complete lines ending at byte offset `endOffset`,
// scanning backward in chunks. Decodes once so multi-byte chars spanning a
// chunk boundary aren't corrupted. Returns lines oldest-first plus the trailing
// partial after the last newline (meaningful only when endOffset is EOF).
function readLinesEndingAt(
  filePath: string,
  endOffset: number,
  maxLines: number,
): { lines: string[]; partial: string } {
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
  return { lines, partial };
}

export function handleTranscriptStream(req: Request): Response {
  const url = new URL(req.url);
  const session = url.searchParams.get("session") ?? "";
  const provider = normalizeProvider(url.searchParams.get("provider"));
  if (!provider) return jsonError("invalid provider");
  if (!UUID_RE.test(session)) return jsonError("invalid session id");

  const resolved = resolveProviderTranscriptPath(provider, session);
  if (!resolved) return jsonError("transcript not found", 404);

  let filePath: string;
  try {
    filePath = realpathSync(resolved);
  } catch {
    return jsonError("transcript not found", 404);
  }
  if (!isInsideProviderRoot(provider, filePath)) {
    return jsonError(
      `transcript path is outside ${providerRootName(provider)}`,
      403,
    );
  }

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

      // backlog — the most recent BACKLOG_LINES, read backward
      try {
        const size = statSync(filePath).size;
        const { lines, partial: trailing } = readLinesEndingAt(
          filePath,
          size,
          BACKLOG_LINES,
        );
        emitLines(enqueue, lines.join("\n"));
        partial = trailing;
        offset = size;
      } catch {
        // file vanished/rotated between resolve and read — backlog stays empty
      }

      enqueue("event: backlog-done\ndata: {}\n\n");

      const readTail = () => {
        if (closed || !existsSync(filePath)) return;
        try {
          const size = statSync(filePath).size;
          if (size < offset) {
            offset = 0;
            partial = "";
          }
          if (size <= offset) return;
          const length = size - offset;
          const buf = Buffer.allocUnsafe(length);
          const fd = openSync(filePath, "r");
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
        watcher = watch(filePath, () => {
          if (debounce) return;
          debounce = setTimeout(() => {
            debounce = null;
            readTail();
          }, WATCH_DEBOUNCE_MS);
        });
      } catch {
        // file disappeared right after resolve; the client can re-open
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
