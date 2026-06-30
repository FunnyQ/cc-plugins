#!/usr/bin/env bun
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import {
  buildClaudeLiveSessions,
  buildCodexLiveSessions,
  buildOpenCodeLiveSessions,
  parseCockpitKeys,
  sortLiveSessions,
  type LiveSession,
} from "./live-sessions";
import { readSessionFiles } from "./session-files";
import { cockpitHome } from "../../cockpit/scripts/cockpit-home";
import { isAlive } from "../../cockpit/scripts/cockpit-channel";
import { isPathInside } from "../../shared/scripts/path-inside";
import {
  CODEX_DIR,
  CODEX_SESSIONS_DIR,
  CODEX_STATE_DB,
  OPENCODE_DB,
  PROJECTS_DIR,
} from "./paths";

export type { LiveSession } from "./live-sessions";

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
const TRANSCRIPT_INDEX_TTL_MS = 5_000;
const COCKPIT_FILE_TTL_MS = 5_000;

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

type OpenCodeSessionRow = {
  id: string;
  directory: string;
  time_created: number;
  time_updated: number;
};

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

function resolveCodexRolloutPath(id: string): string | undefined {
  const row = readCodexThreadRow(id);
  if (!row?.rollout_path) return undefined;
  return isAbsolute(row.rollout_path)
    ? row.rollout_path
    : resolve(CODEX_DIR, row.rollout_path);
}

function readOpenCodeSessionRows(limit = 24): OpenCodeSessionRow[] {
  if (!existsSync(OPENCODE_DB)) return [];
  try {
    const db = new Database(OPENCODE_DB, { readonly: true });
    try {
      return db
        .query(
          `select id, directory, time_created, time_updated
           from session
           order by time_updated desc
           limit ?`,
        )
        .all(limit) as OpenCodeSessionRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
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
  return isPathInside(PROJECTS_REAL, filePath);
}

export function isInsideCodexSessions(filePath: string): boolean {
  return isPathInside(CODEX_SESSIONS_REAL, filePath);
}

// Companion read of cockpit's registry (same machine, same author) so we can
// tag which live sessions have a cockpit decision trail. Membership only — we
// don't touch cockpit's transcript/rendering internals. Missing/corrupt → none.
const COCKPIT_REGISTRY = join(cockpitHome(), "registry.json");
let cockpitSessionKeysCache: Set<string> | null = null;
let cockpitSessionKeysAt = 0;

function cockpitSessionKeys(): Set<string> {
  const now = Date.now();
  if (
    cockpitSessionKeysCache &&
    now - cockpitSessionKeysAt < COCKPIT_FILE_TTL_MS
  ) {
    return cockpitSessionKeysCache;
  }
  try {
    cockpitSessionKeysCache = parseCockpitKeys(
      readFileSync(COCKPIT_REGISTRY, "utf8"),
    );
  } catch {
    // registry missing — no cockpit tags
    cockpitSessionKeysCache = new Set<string>();
  }
  cockpitSessionKeysAt = now;
  return cockpitSessionKeysCache;
}

// Companion read of cockpit's daemon PID file (same machine, same author). The
// Live panel's rows open a session's transcript in cockpit (port 5858), so a
// dead daemon means a dead tab — surface it as a notice instead. Mirrors
// cockpit-server.ts's own liveness check (PID file + signal-0 probe).
const COCKPIT_DAEMON = join(cockpitHome(), "daemon.json");
let cockpitDaemonPortCache: number | null = null;
let cockpitDaemonPortAt = 0;

// The live cockpit daemon's port, or null when it isn't running. Cockpit can
// bind a custom --port, and daemon.json records the real one — the Live panel
// must open that port, not a hardcoded 5858, or a custom-port cockpit opens a
// dead tab despite reading as up.
export function cockpitDaemonPort(): number | null {
  const now = Date.now();
  if (now - cockpitDaemonPortAt < COCKPIT_FILE_TTL_MS) {
    return cockpitDaemonPortCache;
  }
  try {
    const info = JSON.parse(readFileSync(COCKPIT_DAEMON, "utf8"));
    cockpitDaemonPortCache =
      typeof info?.pid === "number" && isAlive(info.pid)
        ? typeof info.port === "number"
          ? info.port
          : 5858
        : null;
  } catch {
    // daemon.json missing or corrupt — treat as not running
    cockpitDaemonPortCache = null;
  }
  cockpitDaemonPortAt = now;
  return cockpitDaemonPortCache;
}

export function getLiveSessions(): LiveSession[] {
  const now = Date.now();
  const index = getTranscriptIndex();
  const cockpitKeys = cockpitSessionKeys();
  const claudeSessions = buildClaudeLiveSessions(
    readSessionFiles(),
    cockpitKeys,
    index,
    now,
  );
  const codexSessions = buildCodexLiveSessions(
    readCodexThreadRows(),
    cockpitKeys,
    now,
    existsSync,
  );
  const openCodeSessions = buildOpenCodeLiveSessions(
    readOpenCodeSessionRows(),
    cockpitKeys,
    now,
  );
  return sortLiveSessions([
    ...claudeSessions,
    ...codexSessions,
    ...openCodeSessions,
  ]);
}

if (import.meta.main) {
  const cockpitPort = cockpitDaemonPort();
  process.stdout.write(
    JSON.stringify(
      {
        sessions: getLiveSessions(),
        cockpitUp: cockpitPort !== null,
        cockpitPort,
      },
      null,
      2,
    ),
  );
}
