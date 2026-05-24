#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
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
const TRANSCRIPT_INDEX_TTL_MS = 5_000;

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
  // true when this live session is also a registered cockpit session (has a
  // decision trail) — surfaced as a badge so you know it's worth opening there.
  cockpit?: boolean;
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

// Companion read of cockpit's registry (same machine, same author) so we can
// tag which live sessions have a cockpit decision trail. Membership only — we
// don't touch cockpit's transcript/rendering internals. Missing/corrupt → none.
const COCKPIT_REGISTRY = join(
  process.env.COCKPIT_HOME || join(homedir(), ".cockpit"),
  "registry.json",
);

function cockpitSessionKeys(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(COCKPIT_REGISTRY, "utf8"));
    if (raw && Array.isArray(raw.sessions)) {
      return new Set<string>(
        raw.sessions
          .filter(
            (s: { sessionId?: unknown }) => typeof s?.sessionId === "string",
          )
          .map(
            (s: { provider?: string; sessionId: string }) =>
              `${s.provider === "codex" ? "codex" : "claude"}:${s.sessionId}`,
          ),
      );
    }
  } catch {
    // registry missing or corrupt — no cockpit tags
  }
  return new Set<string>();
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
  const cockpitKeys = cockpitSessionKeys();
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
        cockpit: cockpitKeys.has(`claude:${session.sessionId}`),
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
        cockpit: cockpitKeys.has(`codex:${row.id}`),
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

if (import.meta.main) {
  process.stdout.write(
    JSON.stringify({ sessions: getLiveSessions() }, null, 2),
  );
}
