#!/usr/bin/env bun
// Persistent rollup DB for Claude transcript usage. The dashboard recomputes all
// usage by re-parsing ~/.claude/projects/**/*.jsonl on every load, but Claude
// Code deletes those transcripts via `cleanupPeriodDays` — so token/cost/model
// history dies with them. This DB holds an additive, hourly-bucketed rollup that
// outlives transcript deletion: `usage_hourly` is the *source* for buildStats's
// Claude aggregates, never the wire format. Cost is intentionally NOT stored —
// it stays a downstream computation against live pricing, so price corrections
// apply retroactively (matching today's behaviour).
//
// Location: ~/.local/share/q-lab/token-atlas/rollup.db (XDG_DATA_HOME), NOT
// ~/.config/ — it's derived-but-authoritative data, not settings, and we keep it
// out of dotfiles sync to avoid Mac↔homelab binary-DB merge conflicts.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const DATA_HOME = process.env.XDG_DATA_HOME || join(HOME, ".local", "share");
export const ROLLUP_DIR = join(DATA_HOME, "q-lab", "token-atlas");
export const ROLLUP_DB_PATH =
  process.env.TOKEN_ATLAS_ROLLUP_DB || join(ROLLUP_DIR, "rollup.db");

// v2 adds request paths; upgrades must preserve history whose transcripts are gone.
// v3 adds the session ledger, so the dashboard stops re-reading every transcript
// just to rebuild it.
export const SCHEMA_VERSION = 3;

// Set when a migration rewinds the cursors, cleared once the ledger is refilled.
export const LEDGER_REBUILD_PENDING = "ledger_rebuild_pending";

// Token grain stored per (hour_ms, project, model). `hour_ms` is the LOCAL
// hour-start in epoch ms (the exact value api.ts's hourStartMs() produces), so
// the daily/heatmap maps reconstruct byte-identically. `hour_ms = 0` is the
// bucket for entries whose timestamp was missing/unparseable — counted in the
// model/project totals but excluded from the hourly/daily maps, mirroring the
// live parser's skip logic. `project` is the entry cwd ("" when absent).
export type HourlyRow = {
  hour_ms: number;
  project: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_creation: number;
  reasoning: number;
  message_count: number;
};

export type IngestedFile = {
  path: string;
  bytes_parsed: number;
  mtime_ms: number;
};

// One row per (file, session_key): a subagent transcript carries its parent's
// sessionId, so a session spans files while a file holds one session. Per-file
// rows prune with the file — unlike usage_hourly, which outlives it.
export type LedgerFileRow = {
  path: string;
  session_key: string;
  /** Entry cwd; "" when absent. */
  project: string;
  /** Timestamp of the entry that supplied `project`, for a stable pick. */
  project_ts_ms: number;
  last_ts_ms: number;
  interactions: number;
  tool_calls: number;
};

export type LedgerModelRow = {
  path: string;
  session_key: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_creation: number;
};

// Open mechanics shared with codex-cache.ts, so the WAL and timeout settings
// cannot drift apart. The databases stay separate files; only this part is common.
export function openSqliteFile(path: string, dir: string): Database {
  if (path !== ":memory:") mkdirSync(dir, { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function openRollupDb(path: string = ROLLUP_DB_PATH): Database {
  const db = openSqliteFile(path, ROLLUP_DIR);
  try {
    backupBeforeUpgrade(db, path);
    db.transaction(() => migrate(db)).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// Snapshot the DB once per schema bump, before migrating. The transaction makes
// a crash harmless; this covers what it cannot — a bug in the migration — against
// history no deleted transcript can rebuild. One file per source version, so a
// retry never overwrites an earlier snapshot.
function backupBeforeUpgrade(db: Database, path: string): void {
  if (path === ":memory:") return;
  let stored: string | null;
  try {
    stored = getMeta(db, "schema_version");
  } catch {
    return; // pre-meta or unreadable — nothing worth preserving
  }
  if (stored === null || stored === String(SCHEMA_VERSION)) return;
  const dest = `${path}.v${stored}.bak`;
  if (existsSync(dest)) return;
  try {
    // VACUUM INTO writes one consistent file, WAL folded in — a plain copy of a
    // WAL database can land mid-checkpoint and read back short.
    db.query("VACUUM INTO ?").run(dest);
  } catch {
    // Out of disk, read-only dir, or an older SQLite: the upgrade is still
    // transactional, so proceed rather than block the dashboard on a backup.
  }
}

function migrate(db: Database): void {
  // meta first — it carries schema_version, which drives the upgrade below.
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

  const stored = getMeta(db, "schema_version");
  const upgradable = new Set(["1", "2"]);
  if (
    stored !== null &&
    !upgradable.has(stored) &&
    stored !== String(SCHEMA_VERSION)
  ) {
    throw new Error(`Unsupported rollup schema version: ${stored}`);
  }
  if (stored === "1" && !hasColumn(db, "seen_requests", "path")) {
    // Legacy keys have no recoverable path; retain them to prevent replay billing.
    db.exec(
      "ALTER TABLE seen_requests ADD COLUMN path TEXT NOT NULL DEFAULT ''",
    );
  }
  if (stored !== null && upgradable.has(stored)) {
    // Ledger tables arrive empty; rewinding cursors reuses --rebuild's replay to
    // backfill them, while seen_requests still blocks re-billing usage_hourly.
    // The flag is what tells updateRollup this is a rebuild — a zeroed cursor on
    // its own is indistinguishable from a file it has simply never seen.
    db.exec("UPDATE ingested_files SET bytes_parsed = 0");
    setMeta(db, LEDGER_REBUILD_PENDING, "1");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS ingested_files (
      path         TEXT PRIMARY KEY,
      bytes_parsed INTEGER NOT NULL,
      mtime_ms     INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seen_requests (
      request_key TEXT PRIMARY KEY,
      path        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seen_requests_path ON seen_requests (path);
    CREATE TABLE IF NOT EXISTS usage_hourly (
      hour_ms        INTEGER NOT NULL,
      project        TEXT    NOT NULL,
      model          TEXT    NOT NULL,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_read     INTEGER NOT NULL DEFAULT 0,
      cache_creation INTEGER NOT NULL DEFAULT 0,
      reasoning      INTEGER NOT NULL DEFAULT 0,
      message_count  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour_ms, project, model)
    );
    CREATE TABLE IF NOT EXISTS seen_tool_calls (
      session_key TEXT NOT NULL,
      tool_key    TEXT NOT NULL,
      PRIMARY KEY (session_key, tool_key)
    );
    CREATE TABLE IF NOT EXISTS session_ledger (
      path          TEXT    NOT NULL,
      session_key   TEXT    NOT NULL,
      project       TEXT    NOT NULL DEFAULT '',
      project_ts_ms INTEGER NOT NULL DEFAULT 0,
      last_ts_ms    INTEGER NOT NULL DEFAULT 0,
      interactions  INTEGER NOT NULL DEFAULT 0,
      tool_calls    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (path, session_key)
    );
    CREATE TABLE IF NOT EXISTS session_model_usage (
      path           TEXT    NOT NULL,
      session_key    TEXT    NOT NULL,
      model          TEXT    NOT NULL,
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_read     INTEGER NOT NULL DEFAULT 0,
      cache_creation INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (path, session_key, model)
    );
  `);

  setMeta(db, "schema_version", String(SCHEMA_VERSION));
}

function hasColumn(db: Database, table: string, column: string): boolean {
  try {
    const cols = db.query(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return cols.some((c) => c.name === column);
  } catch {
    return false;
  }
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getIngestedFile(
  db: Database,
  path: string,
): IngestedFile | null {
  const row = db
    .query(
      "SELECT path, bytes_parsed, mtime_ms FROM ingested_files WHERE path = ?",
    )
    .get(path) as IngestedFile | undefined;
  return row ?? null;
}

export function upsertIngestedFile(
  db: Database,
  file: IngestedFile,
  updatedAt: number,
): void {
  db.query(
    `INSERT INTO ingested_files (path, bytes_parsed, mtime_ms, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       bytes_parsed = excluded.bytes_parsed,
       mtime_ms = excluded.mtime_ms,
       updated_at = excluded.updated_at`,
  ).run(file.path, file.bytes_parsed, file.mtime_ms, updatedAt);
}

export function hasSeenRequest(db: Database, key: string): boolean {
  return (
    db.query("SELECT 1 FROM seen_requests WHERE request_key = ?").get(key) !=
    null
  );
}

export function markSeenRequest(db: Database, key: string, path: string): void {
  db.query(
    "INSERT OR IGNORE INTO seen_requests (request_key, path) VALUES (?, ?)",
  ).run(key, path);
}

// Drop a file's dedup keys when the file itself is gone. Cross-file request
// collisions don't occur, so a key is dead weight once its source file is
// deleted — this is what keeps seen_requests from growing without bound.
export function clearSeenRequestsForFile(db: Database, path: string): void {
  db.query("DELETE FROM seen_requests WHERE path = ?").run(path);
}

// Keyed by (session, tool_key). Per-file would double-count a subagent's repeat
// of its parent's lines; global would swallow a resumed session's legitimate
// replay of another session's message ids. Both were live bugs.
export function hasSeenToolCall(
  db: Database,
  sessionKey: string,
  key: string,
): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM seen_tool_calls WHERE session_key = ? AND tool_key = ?",
      )
      .get(sessionKey, key) != null
  );
}

export function markSeenToolCall(
  db: Database,
  sessionKey: string,
  key: string,
): void {
  db.query(
    "INSERT OR IGNORE INTO seen_tool_calls (session_key, tool_key) VALUES (?, ?)",
  ).run(sessionKey, key);
}

// Pruned per session, so the table needs no path column or index on one — those
// cost 44MB for a delete that runs only when a transcript disappears. A
// session_ledger row survives while any of the session's files do.
export function pruneSeenToolCalls(db: Database): void {
  db.exec(
    `DELETE FROM seen_tool_calls
     WHERE session_key NOT IN (SELECT session_key FROM session_ledger)`,
  );
}

// Additive upsert — each ingest run adds the newly-parsed bytes' tokens onto the
// existing bucket totals. Never an overwrite: the same bucket grows across runs.
export function addHourlyRow(db: Database, row: HourlyRow): void {
  db.query(
    `INSERT INTO usage_hourly
       (hour_ms, project, model, input_tokens, output_tokens, cache_read, cache_creation, reasoning, message_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hour_ms, project, model) DO UPDATE SET
       input_tokens   = input_tokens   + excluded.input_tokens,
       output_tokens  = output_tokens  + excluded.output_tokens,
       cache_read     = cache_read     + excluded.cache_read,
       cache_creation = cache_creation + excluded.cache_creation,
       reasoning      = reasoning      + excluded.reasoning,
       message_count  = message_count  + excluded.message_count`,
  ).run(
    row.hour_ms,
    row.project,
    row.model,
    row.input_tokens,
    row.output_tokens,
    row.cache_read,
    row.cache_creation,
    row.reasoning,
    row.message_count,
  );
}

export function allHourlyRows(db: Database): HourlyRow[] {
  return db
    .query(
      `SELECT hour_ms, project, model, input_tokens, output_tokens,
              cache_read, cache_creation, reasoning, message_count
       FROM usage_hourly`,
    )
    .all() as HourlyRow[];
}

// Replays need existing totals and dedup keys because deleted transcripts cannot be recovered.
export function rewindRollup(db: Database): void {
  db.exec("UPDATE ingested_files SET bytes_parsed = 0");
  // Cleared, unlike seen_requests: the replay rebuilds ledger rows from scratch,
  // so a surviving key here would suppress every re-add and zero tool_calls.
  db.exec("DELETE FROM seen_tool_calls");
}

export function clearIngestedFile(db: Database, path: string): void {
  db.query("DELETE FROM ingested_files WHERE path = ?").run(path);
}

// Ledger rows have no seen_requests-style gate, so a byte-0 replay clears them
// before rewriting; a tail append accumulates onto them. ingestFile is the only
// caller that knows which happened.
export function clearLedgerForFile(db: Database, path: string): void {
  db.query("DELETE FROM session_ledger WHERE path = ?").run(path);
  db.query("DELETE FROM session_model_usage WHERE path = ?").run(path);
}

export function addLedgerRow(db: Database, row: LedgerFileRow): void {
  db.query(
    `INSERT INTO session_ledger
       (path, session_key, project, project_ts_ms, last_ts_ms, interactions, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path, session_key) DO UPDATE SET
       -- Earliest non-zero project_ts_ms wins; 0 means "no timestamp yet".
       project = CASE WHEN excluded.project != ''
              AND (project = '' OR project_ts_ms = 0
                   OR (excluded.project_ts_ms > 0
                       AND excluded.project_ts_ms < project_ts_ms)) THEN excluded.project ELSE project END,
       project_ts_ms = CASE
         WHEN excluded.project != ''
              AND (project = '' OR project_ts_ms = 0
                   OR (excluded.project_ts_ms > 0
                       AND excluded.project_ts_ms < project_ts_ms)) THEN excluded.project_ts_ms ELSE project_ts_ms END,
       last_ts_ms   = MAX(last_ts_ms, excluded.last_ts_ms),
       interactions = interactions + excluded.interactions,
       tool_calls   = tool_calls   + excluded.tool_calls`,
  ).run(
    row.path,
    row.session_key,
    row.project,
    row.project_ts_ms,
    row.last_ts_ms,
    row.interactions,
    row.tool_calls,
  );
}

export function addLedgerModelRow(db: Database, row: LedgerModelRow): void {
  db.query(
    `INSERT INTO session_model_usage
       (path, session_key, model, input_tokens, output_tokens, cache_read, cache_creation)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path, session_key, model) DO UPDATE SET
       input_tokens   = input_tokens   + excluded.input_tokens,
       output_tokens  = output_tokens  + excluded.output_tokens,
       cache_read     = cache_read     + excluded.cache_read,
       cache_creation = cache_creation + excluded.cache_creation`,
  ).run(
    row.path,
    row.session_key,
    row.model,
    row.input_tokens,
    row.output_tokens,
    row.cache_read,
    row.cache_creation,
  );
}

export function allLedgerRows(db: Database): LedgerFileRow[] {
  return db
    .query(
      `SELECT path, session_key, project, project_ts_ms, last_ts_ms,
              interactions, tool_calls
       FROM session_ledger
       ORDER BY project_ts_ms, path`,
    )
    .all() as LedgerFileRow[];
}

export function allLedgerModelRows(db: Database): LedgerModelRow[] {
  return db
    .query(
      `SELECT path, session_key, model, input_tokens, output_tokens,
              cache_read, cache_creation
       FROM session_model_usage`,
    )
    .all() as LedgerModelRow[];
}
