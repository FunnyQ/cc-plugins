// Live-session detection for the cockpit manifest. cockpit's registry only
// knows sessions that were /cockpit-start'd; this surfaces sessions that are
// actually running right now (across every project, tracked or not) so the
// manifest mirrors what's live — the same signal token-atlas's "Live now" panel
// uses. This is only the lightweight session LIST; the transcript renderer is
// not duplicated (transcript-stream.ts remains the single source).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { codexStateDb, excludeCodexSpawnedChildrenSql } from "./codex-db";
import { openCodeDb, openCodeTimestampMs } from "../../shared/scripts/opencode";

export type Provider = "claude" | "codex" | "opencode";

export type LiveSession = {
  provider: Provider;
  id: string;
  cwd: string;
  updatedAtMs: number;
  // Raw harness status. Claude writes this per-session (busy/idle/waiting/shell/
  // …); Codex has no equivalent, so we infer busy/idle from how recently the
  // thread row was touched. registry.ts maps this onto the display vocabulary.
  status: string;
};

// A session counts as live if it signalled within this window — matches the
// stale cutoff token-atlas uses for the same panel.
const STALE_MS = 10 * 60 * 1000;

// Codex/OpenCode emit no live status; a session touched within this window is
// treated as actively working, otherwise idle. Mirrors token-atlas's cutoff.
const CODEX_BUSY_MS = 60 * 1000;

// Dirs/DB are env-overridable so tests can point at fixtures (mirrors the
// overrides transcript-stream.ts already honours).
function claudeSessionsDir(): string {
  return (
    process.env.COCKPIT_CLAUDE_SESSIONS_DIR ||
    join(homedir(), ".claude", "sessions")
  );
}

type ClaudeSessionFile = {
  sessionId: string;
  cwd: string;
  startedAt: number;
  updatedAt?: number;
  status?: string;
};

// Claude writes a JSON file per running session under ~/.claude/sessions/; an
// exited session's file goes stale (no updates) and is filtered by the cutoff.
function readClaudeLive(now: number): LiveSession[] {
  const dir = claudeSessionsDir();
  if (!existsSync(dir)) return [];
  const out: LiveSession[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(
        readFileSync(join(dir, f), "utf-8"),
      ) as ClaudeSessionFile;
      if (
        !d ||
        typeof d.sessionId !== "string" ||
        typeof d.cwd !== "string" ||
        typeof d.startedAt !== "number"
      ) {
        continue;
      }
      const updatedAtMs = d.updatedAt ?? d.startedAt;
      if (now - updatedAtMs > STALE_MS) continue;
      out.push({
        provider: "claude",
        id: d.sessionId,
        cwd: d.cwd,
        updatedAtMs,
        status: typeof d.status === "string" ? d.status : "idle",
      });
    } catch {
      // skip malformed / partially-written file
    }
  }
  return out;
}

type CodexThreadRow = {
  id: string;
  cwd: string;
  updated_at: number;
  updated_at_ms: number | null;
};

type OpenCodeSessionRow = {
  id: string;
  directory: string;
  time_created: number;
  time_updated: number;
};

// Codex has no per-session file; the `threads` table's most-recent rows stand in
// for "recently active". Same cutoff keeps the two providers consistent. Spawned
// child threads are excluded here so subagents only appear as the parent
// session's `subagents` count, not as separate untracked sessions in the rail.
function readCodexLive(now: number): LiveSession[] {
  const dbPath = codexStateDb();
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const excludeSpawnedChildren = excludeCodexSpawnedChildrenSql(db);
      const rows = db
        .query(
          `select id, cwd, updated_at, updated_at_ms
           from threads
           where archived = 0 and rollout_path != ''
             ${excludeSpawnedChildren}
           order by coalesce(updated_at_ms, updated_at * 1000) desc
           limit 24`,
        )
        .all() as CodexThreadRow[];
      const out: LiveSession[] = [];
      for (const r of rows) {
        if (typeof r.id !== "string" || typeof r.cwd !== "string") continue;
        const updatedAtMs = r.updated_at_ms ?? r.updated_at * 1000;
        if (now - updatedAtMs > STALE_MS) continue;
        out.push({
          provider: "codex",
          id: r.id,
          cwd: r.cwd,
          updatedAtMs,
          status: now - updatedAtMs <= CODEX_BUSY_MS ? "busy" : "idle",
        });
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function readOpenCodeLive(now: number): LiveSession[] {
  const dbPath = openCodeDb();
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .query(
          `select id, directory, time_created, time_updated
           from session
           where time_archived is null
           order by time_updated desc
           limit 24`,
        )
        .all() as OpenCodeSessionRow[];
      const out: LiveSession[] = [];
      for (const r of rows) {
        if (typeof r.id !== "string" || typeof r.directory !== "string") {
          continue;
        }
        const updatedAtMs =
          openCodeTimestampMs(r.time_updated) ||
          openCodeTimestampMs(r.time_created);
        if (!updatedAtMs || now - updatedAtMs > STALE_MS) continue;
        out.push({
          provider: "opencode",
          id: r.id,
          cwd: r.directory,
          updatedAtMs,
          status: now - updatedAtMs <= CODEX_BUSY_MS ? "busy" : "idle",
        });
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export function getLiveSessions(now = Date.now()): LiveSession[] {
  return [
    ...readClaudeLive(now),
    ...readCodexLive(now),
    ...readOpenCodeLive(now),
  ];
}

if (import.meta.main) {
  process.stdout.write(JSON.stringify(getLiveSessions(), null, 2) + "\n");
}
