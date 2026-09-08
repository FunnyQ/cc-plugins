// Per-file cache of Codex rollout summaries, keyed on size + mtime. A rollout is
// append-only but is folded whole (last token_count wins), so there is no
// tail-parse equivalent — the whole summary is recomputed or reused.
//
// Kept out of rollup.db deliberately: that database is authoritative history no
// deleted transcript can rebuild, this one is disposable.
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { openSqliteFile, ROLLUP_DIR } from "./rollup-db";

export const CODEX_CACHE_PATH = join(ROLLUP_DIR, "codex-sessions.db");

type CacheRow = {
  path: string;
  size: number;
  mtime_ms: number;
  summary: string;
};

export function openCodexCache(path: string = CODEX_CACHE_PATH): Database {
  const db = openSqliteFile(path, ROLLUP_DIR);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summary (
      path     TEXT PRIMARY KEY,
      size     INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      summary  TEXT NOT NULL
    );
  `);
  return db;
}

// Summarises every file, reusing the cached result for those unchanged since
// last time. One bulk read and one write transaction, rather than a query per
// file — the cold path writes ~2,000 rows.
export function summariseSessions<T>(
  db: Database,
  files: Iterable<string>,
  compute: (file: string) => T,
): Map<string, T> {
  const cached = new Map(
    (
      db
        .query("SELECT path, size, mtime_ms, summary FROM session_summary")
        .all() as CacheRow[]
    ).map((r) => [r.path, r]),
  );

  const out = new Map<string, T>();
  const writes: CacheRow[] = [];
  for (const file of files) {
    let size: number;
    let mtimeMs: number;
    try {
      const st = statSync(file);
      size = st.size;
      mtimeMs = Math.floor(st.mtimeMs);
    } catch {
      out.set(file, compute(file));
      continue;
    }

    const row = cached.get(file);
    if (row && row.size === size && row.mtime_ms === mtimeMs) {
      try {
        out.set(file, JSON.parse(row.summary) as T);
        continue;
      } catch {
        // corrupt row — recompute below
      }
    }

    // A null summary (unreadable file) is cached too; re-reading it every load
    // is the cost this exists to avoid.
    const summary = compute(file);
    out.set(file, summary);
    writes.push({
      path: file,
      size,
      mtime_ms: mtimeMs,
      summary: JSON.stringify(summary ?? null),
    });
  }

  if (writes.length > 0) {
    const insert = db.query(
      `INSERT INTO session_summary (path, size, mtime_ms, summary)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         summary = excluded.summary`,
    );
    db.transaction(() => {
      for (const w of writes) insert.run(w.path, w.size, w.mtime_ms, w.summary);
    })();
  }

  pruneCache(db, out);
  return out;
}

// Drop rows whose rollout is gone — the cache holds nothing the files do not.
function pruneCache(db: Database, present: Map<string, unknown>): void {
  const known = db.query("SELECT path FROM session_summary").all() as {
    path: string;
  }[];
  const gone = known.filter((k) => !present.has(k.path));
  if (gone.length === 0) return;
  const del = db.query("DELETE FROM session_summary WHERE path = ?");
  db.transaction(() => {
    for (const { path } of gone) del.run(path);
  })();
}
