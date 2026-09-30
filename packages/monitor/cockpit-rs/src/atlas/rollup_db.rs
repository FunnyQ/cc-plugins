// Port of rollup-db.ts: the rollup outlives transcript deletion, so every write here guards
// history that nothing else can rebuild.
// Only tests call the accessors until the ingest port lands; its first caller removes this allow.
#![allow(dead_code)]

use anyhow::{Context, anyhow};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 3;

// Set when a migration rewinds the cursors, cleared once the ledger is refilled.
pub const LEDGER_REBUILD_PENDING: &str = "ledger_rebuild_pending";

// `hour_ms` is the LOCAL hour start (dedup::hour_start_ms), so daily and heatmap maps rebuild
// byte-identically; `0` buckets entries whose timestamp was missing.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HourlyRow {
    pub hour_ms: i64,
    pub project: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
    pub reasoning: i64,
    pub message_count: i64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct IngestedFile {
    pub path: String,
    pub bytes_parsed: i64,
    pub mtime_ms: i64,
}

// Keyed per (file, session): a session spans files, so per-file rows can prune with the file.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LedgerFileRow {
    pub path: String,
    pub session_key: String,
    pub project: String,
    pub project_ts_ms: i64,
    pub last_ts_ms: i64,
    pub interactions: i64,
    pub tool_calls: i64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LedgerModelRow {
    pub path: String,
    pub session_key: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
}

// Whitespace matches rollup-db.ts: sqlite_master stores each statement's text as written.
const SCHEMA_DDL: &str = "
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
  ";

// Shared with codex-sessions.db, so the WAL and timeout settings cannot drift apart.
pub fn open_sqlite_file(path: &Path) -> anyhow::Result<Connection> {
    if path != Path::new(":memory:")
        && let Some(dir) = path.parent().filter(|dir| !dir.as_os_str().is_empty())
    {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL")?;
    conn.execute_batch("PRAGMA busy_timeout = 5000")?;
    Ok(conn)
}

pub fn open_rollup_db(path: &Path) -> anyhow::Result<Connection> {
    let mut conn = open_sqlite_file(path)?;
    let in_memory = path == Path::new(":memory:");
    // First, so the snapshot is the file exactly as the TS last left it, before its own
    // upgrade backup or cursor rewind below changes anything.
    if !in_memory {
        backup_before_rust(&conn, path)?;
        backup_before_upgrade(&conn, path);
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    migrate(&tx)?;
    tx.commit()?;
    Ok(conn)
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(suffix);
    PathBuf::from(name)
}

// The only undo for a Rust ingest bug in authoritative history, so unlike the TS upgrade
// backup a failure here refuses the open: `writer` stays unset and the next open retries.
fn backup_before_rust(conn: &Connection, path: &Path) -> anyhow::Result<()> {
    // No readable meta means a brand-new file: nothing to lose.
    let Ok(writer) = get_meta(conn, "writer") else {
        return Ok(());
    };
    let dest = sibling(path, ".pre-rust.bak");
    if writer.as_deref() == Some("rust") || dest.exists() {
        return Ok(());
    }
    // A partial file left by a failed write is not removed: a concurrent opener may own it.
    vacuum_into(conn, &dest).map_err(|cause| anyhow!("pre-rust backup failed: {cause}"))
}

// One snapshot per source version, taken before the version check as the TS does, so even a
// refused newer DB gets its `.v<N>.bak`.
fn backup_before_upgrade(conn: &Connection, path: &Path) {
    let Ok(stored) = get_meta(conn, "schema_version") else {
        return;
    };
    let Some(stored) = stored.filter(|v| *v != SCHEMA_VERSION.to_string()) else {
        return;
    };
    let dest = sibling(path, &format!(".v{stored}.bak"));
    if dest.exists() {
        return;
    }
    // Swallowed as in the TS: the migration is still transactional, so a full disk or a
    // read-only dir should not block the dashboard.
    let _ = vacuum_into(conn, &dest);
}

// VACUUM INTO folds the WAL into one consistent file; a plain copy can read back short.
fn vacuum_into(conn: &Connection, dest: &Path) -> anyhow::Result<()> {
    let dest = dest
        .to_str()
        .ok_or_else(|| anyhow!("non-UTF-8 path {}", dest.display()))?;
    conn.execute("VACUUM INTO ?", [dest])?;
    Ok(())
}

fn migrate(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")?;

    let stored = get_meta(conn, "schema_version")?;
    let upgradable = matches!(stored.as_deref(), Some("1" | "2"));
    if let Some(version) = &stored
        && !upgradable
        && *version != SCHEMA_VERSION.to_string()
    {
        return Err(anyhow!("Unsupported rollup schema version: {version}"));
    }
    if stored.as_deref() == Some("1") && !has_column(conn, "seen_requests", "path") {
        // Legacy keys have no recoverable path; retain them to prevent replay billing.
        conn.execute_batch("ALTER TABLE seen_requests ADD COLUMN path TEXT NOT NULL DEFAULT ''")?;
    }
    if upgradable {
        // The flag is what tells the ingest this is a rebuild; a zeroed cursor alone looks
        // like a file it has never seen. seen_requests still blocks re-billing usage_hourly.
        conn.execute_batch("UPDATE ingested_files SET bytes_parsed = 0")?;
        set_meta(conn, LEDGER_REBUILD_PENDING, "1")?;
    }

    conn.execute_batch(SCHEMA_DDL)?;

    set_meta(conn, "schema_version", &SCHEMA_VERSION.to_string())?;
    // Rust-only key, written only by a successful migration; the TS ignores unknown meta keys.
    set_meta(conn, "writer", "rust")?;
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let names = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>("name"))?
                .collect::<rusqlite::Result<Vec<String>>>()
        });
    names.is_ok_and(|names| names.iter().any(|name| name == column))
}

pub(crate) fn get_meta(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?", [key], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()?
        .flatten())
}

pub(crate) fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

pub(crate) fn get_ingested_file(
    conn: &Connection,
    path: &str,
) -> rusqlite::Result<Option<IngestedFile>> {
    conn.query_row(
        "SELECT path, bytes_parsed, mtime_ms FROM ingested_files WHERE path = ?",
        [path],
        |row| {
            Ok(IngestedFile {
                path: row.get(0)?,
                bytes_parsed: row.get(1)?,
                mtime_ms: row.get(2)?,
            })
        },
    )
    .optional()
}

pub(crate) fn upsert_ingested_file(
    conn: &Connection,
    file: &IngestedFile,
    updated_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO ingested_files (path, bytes_parsed, mtime_ms, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       bytes_parsed = excluded.bytes_parsed,
       mtime_ms = excluded.mtime_ms,
       updated_at = excluded.updated_at",
        params![file.path, file.bytes_parsed, file.mtime_ms, updated_at],
    )?;
    Ok(())
}

pub(crate) fn has_seen_request(conn: &Connection, key: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM seen_requests WHERE request_key = ?",
        [key],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
}

pub(crate) fn mark_seen_request(conn: &Connection, key: &str, path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO seen_requests (request_key, path) VALUES (?, ?)",
        [key, path],
    )?;
    Ok(())
}

// Only for a transcript pruned as deleted; this is what keeps seen_requests bounded.
pub(crate) fn clear_seen_requests_for_file(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM seen_requests WHERE path = ?", [path])?;
    Ok(())
}

// Per session: per file double-counts a subagent's repeat of its parent's lines, and global
// swallows a resumed session's legitimate replay of another session's message ids.
pub(crate) fn has_seen_tool_call(
    conn: &Connection,
    session_key: &str,
    key: &str,
) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM seen_tool_calls WHERE session_key = ? AND tool_key = ?",
        [session_key, key],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
}

pub(crate) fn mark_seen_tool_call(
    conn: &Connection,
    session_key: &str,
    key: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO seen_tool_calls (session_key, tool_key) VALUES (?, ?)",
        [session_key, key],
    )?;
    Ok(())
}

pub(crate) fn prune_seen_tool_calls(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DELETE FROM seen_tool_calls
     WHERE session_key NOT IN (SELECT session_key FROM session_ledger)",
    )
}

// Additive, never an overwrite: each run adds its newly parsed bytes onto the bucket.
pub(crate) fn add_hourly_row(conn: &Connection, row: &HourlyRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO usage_hourly
       (hour_ms, project, model, input_tokens, output_tokens, cache_read, cache_creation, reasoning, message_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hour_ms, project, model) DO UPDATE SET
       input_tokens   = input_tokens   + excluded.input_tokens,
       output_tokens  = output_tokens  + excluded.output_tokens,
       cache_read     = cache_read     + excluded.cache_read,
       cache_creation = cache_creation + excluded.cache_creation,
       reasoning      = reasoning      + excluded.reasoning,
       message_count  = message_count  + excluded.message_count",
        params![
            row.hour_ms,
            row.project,
            row.model,
            row.input_tokens,
            row.output_tokens,
            row.cache_read,
            row.cache_creation,
            row.reasoning,
            row.message_count,
        ],
    )?;
    Ok(())
}

pub(crate) fn all_hourly_rows(conn: &Connection) -> rusqlite::Result<Vec<HourlyRow>> {
    let mut stmt = conn.prepare(
        "SELECT hour_ms, project, model, input_tokens, output_tokens,
              cache_read, cache_creation, reasoning, message_count
       FROM usage_hourly",
    )?;
    stmt.query_map([], |row| {
        Ok(HourlyRow {
            hour_ms: row.get(0)?,
            project: row.get(1)?,
            model: row.get(2)?,
            input_tokens: row.get(3)?,
            output_tokens: row.get(4)?,
            cache_read: row.get(5)?,
            cache_creation: row.get(6)?,
            reasoning: row.get(7)?,
            message_count: row.get(8)?,
        })
    })?
    .collect()
}

// Keeps usage_hourly and seen_requests: deleted transcripts cannot be replayed to refill them.
pub(crate) fn rewind_rollup(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("UPDATE ingested_files SET bytes_parsed = 0")?;
    // Cleared, unlike seen_requests: the replay rebuilds ledger rows from scratch, so a
    // surviving key would suppress every re-add and zero tool_calls.
    conn.execute_batch("DELETE FROM seen_tool_calls")
}

pub(crate) fn clear_ingested_file(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM ingested_files WHERE path = ?", [path])?;
    Ok(())
}

// Ledger rows have no seen_requests-style gate, so a byte-0 replay clears them first.
pub(crate) fn clear_ledger_for_file(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM session_ledger WHERE path = ?", [path])?;
    conn.execute("DELETE FROM session_model_usage WHERE path = ?", [path])?;
    Ok(())
}

pub(crate) fn add_ledger_row(conn: &Connection, row: &LedgerFileRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO session_ledger
       (path, session_key, project, project_ts_ms, last_ts_ms, interactions, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path, session_key) DO UPDATE SET
       -- Earliest non-zero project_ts_ms wins; 0 means \"no timestamp yet\".
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
       tool_calls   = tool_calls   + excluded.tool_calls",
        params![
            row.path,
            row.session_key,
            row.project,
            row.project_ts_ms,
            row.last_ts_ms,
            row.interactions,
            row.tool_calls,
        ],
    )?;
    Ok(())
}

pub(crate) fn add_ledger_model_row(
    conn: &Connection,
    row: &LedgerModelRow,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO session_model_usage
       (path, session_key, model, input_tokens, output_tokens, cache_read, cache_creation)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path, session_key, model) DO UPDATE SET
       input_tokens   = input_tokens   + excluded.input_tokens,
       output_tokens  = output_tokens  + excluded.output_tokens,
       cache_read     = cache_read     + excluded.cache_read,
       cache_creation = cache_creation + excluded.cache_creation",
        params![
            row.path,
            row.session_key,
            row.model,
            row.input_tokens,
            row.output_tokens,
            row.cache_read,
            row.cache_creation,
        ],
    )?;
    Ok(())
}

pub(crate) fn all_ledger_rows(conn: &Connection) -> rusqlite::Result<Vec<LedgerFileRow>> {
    let mut stmt = conn.prepare(
        "SELECT path, session_key, project, project_ts_ms, last_ts_ms,
              interactions, tool_calls
       FROM session_ledger
       ORDER BY project_ts_ms, path",
    )?;
    stmt.query_map([], |row| {
        Ok(LedgerFileRow {
            path: row.get(0)?,
            session_key: row.get(1)?,
            project: row.get(2)?,
            project_ts_ms: row.get(3)?,
            last_ts_ms: row.get(4)?,
            interactions: row.get(5)?,
            tool_calls: row.get(6)?,
        })
    })?
    .collect()
}

pub(crate) fn all_ledger_model_rows(conn: &Connection) -> rusqlite::Result<Vec<LedgerModelRow>> {
    let mut stmt = conn.prepare(
        "SELECT path, session_key, model, input_tokens, output_tokens,
              cache_read, cache_creation
       FROM session_model_usage",
    )?;
    stmt.query_map([], |row| {
        Ok(LedgerModelRow {
            path: row.get(0)?,
            session_key: row.get(1)?,
            model: row.get(2)?,
            input_tokens: row.get(3)?,
            output_tokens: row.get(4)?,
            cache_read: row.get(5)?,
            cache_creation: row.get(6)?,
        })
    })?
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLES: [&str; 7] = [
        "meta",
        "ingested_files",
        "seen_requests",
        "usage_hourly",
        "seen_tool_calls",
        "session_ledger",
        "session_model_usage",
    ];

    const V2_DDL: &str = "
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE ingested_files (path TEXT PRIMARY KEY, bytes_parsed INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE seen_requests (request_key TEXT PRIMARY KEY, path TEXT NOT NULL);
        CREATE INDEX idx_seen_requests_path ON seen_requests (path);
        CREATE TABLE usage_hourly (hour_ms INTEGER NOT NULL, project TEXT NOT NULL,
          model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
          cache_creation INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
          message_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_ms, project, model));
        INSERT INTO meta VALUES ('schema_version', '2');
        INSERT INTO ingested_files VALUES ('/t/a.jsonl', 4096, 111, 222);
        INSERT INTO seen_requests VALUES ('req:msg', '/t/a.jsonl');
        INSERT INTO usage_hourly VALUES (3600000, '/p', 'claude-opus', 1, 2, 3, 4, 5, 6);
    ";

    fn db_in(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("rollup.db")
    }

    // A v3 file as the TS leaves it: every table populated, no `writer` key.
    fn ts_v3_db(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("PRAGMA journal_mode = WAL").unwrap();
        conn.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
            .unwrap();
        conn.execute_batch(SCHEMA_DDL).unwrap();
        conn.execute_batch(
            "INSERT INTO meta VALUES ('schema_version', '3');
             INSERT INTO ingested_files VALUES ('/t/a.jsonl', 4096, 111, 222);
             INSERT INTO seen_requests VALUES ('req:msg', '/t/a.jsonl');
             INSERT INTO usage_hourly VALUES (3600000, '/p', 'claude-opus', 1, 2, 3, 4, 5, 6);
             INSERT INTO seen_tool_calls VALUES ('s1', 'tool-1');
             INSERT INTO session_ledger VALUES ('/t/a.jsonl', 's1', '/p', 100, 200, 3, 1);
             INSERT INTO session_model_usage VALUES ('/t/a.jsonl', 's1', 'claude-opus', 1, 2, 3, 4);",
        )
        .unwrap();
    }

    // Every row of every table present, as sorted debug strings, so two files compare by value.
    fn dump(path: &Path) -> Vec<(String, Vec<String>)> {
        let conn = Connection::open(path).unwrap();
        let mut out = Vec::new();
        for table in TABLES {
            let exists: bool = conn
                .query_row(
                    "SELECT count(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = ?",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            if !exists {
                continue;
            }
            let mut stmt = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
            let width = stmt.column_count();
            let mut rows: Vec<String> = stmt
                .query_map([], |row| {
                    (0..width)
                        .map(|i| row.get::<_, rusqlite::types::Value>(i))
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .map(|values| format!("{values:?}"))
                })
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            rows.sort();
            out.push((table.to_string(), rows));
        }
        out
    }

    fn without_writer(mut tables: Vec<(String, Vec<String>)>) -> Vec<(String, Vec<String>)> {
        for (name, rows) in &mut tables {
            if name == "meta" {
                rows.retain(|row| !row.contains("Text(\"writer\")"));
            }
        }
        tables
    }

    fn meta(path: &Path, key: &str) -> Option<String> {
        get_meta(&Connection::open(path).unwrap(), key).unwrap()
    }

    #[test]
    fn fresh_db_is_v3_rust_written_with_no_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_in(&dir);
        let conn = open_rollup_db(&path).unwrap();
        assert_eq!(
            get_meta(&conn, "schema_version").unwrap().as_deref(),
            Some("3")
        );
        assert_eq!(get_meta(&conn, "writer").unwrap().as_deref(), Some("rust"));
        let baks: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".bak"))
            .collect();
        assert!(baks.is_empty(), "unexpected backups: {baks:?}");
    }

    #[test]
    fn ts_v3_db_gets_pre_rust_backup_equal_to_original() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_in(&dir);
        ts_v3_db(&path);
        let before = dump(&path);
        drop(open_rollup_db(&path).unwrap());
        let bak = sibling(&path, ".pre-rust.bak");
        assert_eq!(dump(&bak), before);
        assert_eq!(without_writer(dump(&path)), before);
        assert_eq!(meta(&path, "writer").as_deref(), Some("rust"));
        assert!(!sibling(&path, ".v3.bak").exists());
    }

    #[test]
    fn pre_rust_backup_is_taken_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_in(&dir);
        ts_v3_db(&path);
        drop(open_rollup_db(&path).unwrap());
        let bak = sibling(&path, ".pre-rust.bak");
        let first = std::fs::metadata(&bak).unwrap();
        drop(open_rollup_db(&path).unwrap());
        let second = std::fs::metadata(&bak).unwrap();
        assert_eq!(first.modified().unwrap(), second.modified().unwrap());
        assert_eq!(first.len(), second.len());
    }

    #[test]
    fn existing_pre_rust_backup_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_in(&dir);
        ts_v3_db(&path);
        let bak = sibling(&path, ".pre-rust.bak");
        std::fs::write(&bak, "sentinel").unwrap();
        drop(open_rollup_db(&path).unwrap());
        assert_eq!(std::fs::read_to_string(&bak).unwrap(), "sentinel");
        assert_eq!(meta(&path, "writer").as_deref(), Some("rust"));
    }

    #[test]
    fn failed_pre_rust_backup_refuses_the_open_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_in(&dir);
        ts_v3_db(&path);
        let before = dump(&path);
        // A dangling link reads as absent, and VACUUM INTO cannot create its missing target dir.
        let bak = sibling(&path, ".pre-rust.bak");
        std::os::unix::fs::symlink(dir.path().join("missing/dir/target.db"), &bak).unwrap();
        let err = open_rollup_db(&path).unwrap_err().to_string();
        assert!(
            err.starts_with("pre-rust backup failed: "),
            "unexpected error: {err}"
        );
        assert_eq!(meta(&path, "writer"), None);
        assert_eq!(dump(&path), before);
    }

    #[test]
    fn v2_db_migrates_to_v3_and_rewinds_cursors() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_in(&dir);
        Connection::open(&path)
            .unwrap()
            .execute_batch(V2_DDL)
            .unwrap();
        let before = dump(&path);
        let conn = open_rollup_db(&path).unwrap();
        assert!(sibling(&path, ".v2.bak").exists());
        assert_eq!(dump(&sibling(&path, ".v2.bak")), before);
        assert_eq!(
            get_meta(&conn, "schema_version").unwrap().as_deref(),
            Some("3")
        );
        assert_eq!(
            get_meta(&conn, LEDGER_REBUILD_PENDING).unwrap().as_deref(),
            Some("1")
        );
        let cursors: Vec<i64> = conn
            .prepare("SELECT bytes_parsed FROM ingested_files")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(cursors, vec![0]);
        drop(conn);
        let after = dump(&path);
        for table in ["seen_requests", "usage_hourly"] {
            let find = |tables: &[(String, Vec<String>)]| {
                tables.iter().find(|(name, _)| name == table).cloned()
            };
            assert_eq!(find(&after), find(&before), "{table} changed");
        }
    }

    #[test]
    fn v1_db_gains_seen_requests_path_and_keeps_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_in(&dir);
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                 CREATE TABLE seen_requests (request_key TEXT PRIMARY KEY);
                 CREATE TABLE ingested_files (path TEXT PRIMARY KEY, bytes_parsed INTEGER NOT NULL,
                   mtime_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 INSERT INTO meta VALUES ('schema_version', '1');
                 INSERT INTO seen_requests VALUES ('legacy:1'), ('legacy:2');",
            )
            .unwrap();
        let conn = open_rollup_db(&path).unwrap();
        let rows: Vec<(String, String)> = conn
            .prepare("SELECT request_key, path FROM seen_requests ORDER BY request_key")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("legacy:1".to_string(), String::new()),
                ("legacy:2".to_string(), String::new()),
            ]
        );
        assert!(has_seen_request(&conn, "legacy:1").unwrap());
        assert!(sibling(&path, ".v1.bak").exists());
    }

    #[test]
    fn newer_version_is_refused_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_in(&dir);
        ts_v3_db(&path);
        Connection::open(&path)
            .unwrap()
            .execute_batch("UPDATE meta SET value = '99' WHERE key = 'schema_version'")
            .unwrap();
        let before = dump(&path);
        let err = open_rollup_db(&path).unwrap_err();
        assert_eq!(err.to_string(), "Unsupported rollup schema version: 99");
        assert_eq!(dump(&path), before);
        assert_eq!(meta(&path, "writer"), None);
        assert!(sibling(&path, ".v99.bak").exists());
    }

    #[test]
    fn opener_sets_wal_and_busy_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_sqlite_file(&dir.path().join("nested/x.db")).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        let timeout: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        assert_eq!(timeout, 5000);
    }

    #[test]
    fn add_hourly_row_sums_every_count() {
        let conn = open_rollup_db(Path::new(":memory:")).unwrap();
        let row = HourlyRow {
            hour_ms: 3_600_000,
            project: "/p".into(),
            model: "m".into(),
            input_tokens: 1,
            output_tokens: 2,
            cache_read: 3,
            cache_creation: 4,
            reasoning: 5,
            message_count: 6,
        };
        add_hourly_row(&conn, &row).unwrap();
        add_hourly_row(&conn, &row).unwrap();
        assert_eq!(
            all_hourly_rows(&conn).unwrap(),
            vec![HourlyRow {
                input_tokens: 2,
                output_tokens: 4,
                cache_read: 6,
                cache_creation: 8,
                reasoning: 10,
                message_count: 12,
                ..row
            }]
        );
    }

    #[test]
    fn add_ledger_row_keeps_earliest_nonzero_project() {
        let conn = open_rollup_db(Path::new(":memory:")).unwrap();
        let row = |project: &str, project_ts_ms: i64, last_ts_ms: i64| LedgerFileRow {
            path: "/t/a.jsonl".into(),
            session_key: "s1".into(),
            project: project.into(),
            project_ts_ms,
            last_ts_ms,
            interactions: 1,
            tool_calls: 2,
        };
        add_ledger_row(&conn, &row("/late", 200, 200)).unwrap();
        add_ledger_row(&conn, &row("/early", 100, 150)).unwrap();
        add_ledger_row(&conn, &row("/untimed", 0, 300)).unwrap();
        add_ledger_row(&conn, &row("/later", 250, 250)).unwrap();
        add_ledger_row(&conn, &row("", 50, 50)).unwrap();
        assert_eq!(
            all_ledger_rows(&conn).unwrap(),
            vec![LedgerFileRow {
                path: "/t/a.jsonl".into(),
                session_key: "s1".into(),
                project: "/early".into(),
                project_ts_ms: 100,
                last_ts_ms: 300,
                interactions: 5,
                tool_calls: 10,
            }]
        );
    }

    #[test]
    fn rewind_zeroes_cursors_and_tool_calls_but_keeps_seen_requests() {
        let conn = open_rollup_db(Path::new(":memory:")).unwrap();
        let file = IngestedFile {
            path: "/t/a.jsonl".into(),
            bytes_parsed: 4096,
            mtime_ms: 111,
        };
        upsert_ingested_file(&conn, &file, 222).unwrap();
        mark_seen_request(&conn, "req:msg", "/t/a.jsonl").unwrap();
        mark_seen_tool_call(&conn, "s1", "tool-1").unwrap();
        rewind_rollup(&conn).unwrap();
        assert_eq!(
            get_ingested_file(&conn, "/t/a.jsonl").unwrap(),
            Some(IngestedFile {
                bytes_parsed: 0,
                ..file
            })
        );
        assert!(!has_seen_tool_call(&conn, "s1", "tool-1").unwrap());
        assert!(has_seen_request(&conn, "req:msg").unwrap());
    }

    #[test]
    fn per_file_clears_and_tool_call_prune() {
        let conn = open_rollup_db(Path::new(":memory:")).unwrap();
        let ledger = |path: &str, session_key: &str| LedgerFileRow {
            path: path.into(),
            session_key: session_key.into(),
            ..LedgerFileRow::default()
        };
        let usage = LedgerModelRow {
            path: "/a".into(),
            session_key: "s1".into(),
            model: "m".into(),
            input_tokens: 1,
            output_tokens: 2,
            cache_read: 3,
            cache_creation: 4,
        };
        add_ledger_row(&conn, &ledger("/a", "s1")).unwrap();
        add_ledger_row(&conn, &ledger("/b", "s2")).unwrap();
        add_ledger_model_row(&conn, &usage).unwrap();
        add_ledger_model_row(&conn, &usage).unwrap();
        assert_eq!(all_ledger_model_rows(&conn).unwrap()[0].cache_creation, 8);
        mark_seen_tool_call(&conn, "s1", "t").unwrap();
        mark_seen_tool_call(&conn, "s2", "t").unwrap();
        mark_seen_request(&conn, "r1", "/a").unwrap();

        clear_ledger_for_file(&conn, "/a").unwrap();
        clear_seen_requests_for_file(&conn, "/a").unwrap();
        prune_seen_tool_calls(&conn).unwrap();

        assert!(all_ledger_model_rows(&conn).unwrap().is_empty());
        assert_eq!(all_ledger_rows(&conn).unwrap(), vec![ledger("/b", "s2")]);
        assert!(!has_seen_tool_call(&conn, "s1", "t").unwrap());
        assert!(has_seen_tool_call(&conn, "s2", "t").unwrap());
        assert!(!has_seen_request(&conn, "r1").unwrap());

        upsert_ingested_file(&conn, &IngestedFile::default(), 0).unwrap();
        clear_ingested_file(&conn, "").unwrap();
        assert_eq!(get_ingested_file(&conn, "").unwrap(), None);
    }
}
