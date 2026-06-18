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
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const DATA_HOME = process.env.XDG_DATA_HOME || join(HOME, ".local", "share");
export const ROLLUP_DIR = join(DATA_HOME, "q-lab", "token-atlas");
export const ROLLUP_DB_PATH =
  process.env.TOKEN_ATLAS_ROLLUP_DB || join(ROLLUP_DIR, "rollup.db");

// v2: seen_requests gained a `path` column so a deleted/cleaned-up transcript's
// dedup keys are pruned alongside its ingested_files row (bounds unbounded growth
// — cross-file request collisions don't happen, so a key is only ever needed
// while its own file is still being appended to). A version bump triggers a clean
// rebuild of the (fully derived) rollup, which is why `meta` carries this at all.
export const SCHEMA_VERSION = 2;

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

export function openRollupDb(path: string = ROLLUP_DB_PATH): Database {
  if (path !== ":memory:") {
    mkdirSync(ROLLUP_DIR, { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  // meta first — it carries schema_version, which drives the upgrade below.
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

  const stored = getMeta(db, "schema_version");
  if (stored !== null && Number(stored) < SCHEMA_VERSION) {
    // Destructive upgrade: the rollup is fully derived from on-disk transcripts,
    // so the safe way to change schema is to drop the aggregate/bookkeeping
    // tables and let the next updateRollup() re-ingest everything from scratch.
    // (A partial migration would corrupt usage_hourly's additive totals.)
    db.exec(`
      DROP TABLE IF EXISTS usage_hourly;
      DROP TABLE IF EXISTS seen_requests;
      DROP TABLE IF EXISTS ingested_files;
    `);
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
  `);

  setMeta(db, "schema_version", String(SCHEMA_VERSION));
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

// Drop every ingested-state + aggregate row. Used by the truncation→rebuild path
// and `rollup-update --rebuild`. Wrapped by the caller in a transaction.
export function resetRollup(db: Database): void {
  db.exec(`
    DELETE FROM usage_hourly;
    DELETE FROM seen_requests;
    DELETE FROM ingested_files;
  `);
}

export function clearIngestedFile(db: Database, path: string): void {
  db.query("DELETE FROM ingested_files WHERE path = ?").run(path);
}
